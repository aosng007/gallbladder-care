import { isConfigured, pipeline } from './_redis.js';
import { clientIp } from './_ip.js';

// Reads the weight shown in a photo of a bathroom scale.
// Uses Gemini (GEMINI_API_KEY) if set, otherwise Google Cloud Vision OCR (GOOGLE_VISION_API_KEY).

const MAX_PER_HOUR = 30;
const MAX_IMAGE_CHARS = 3_000_000; // ~2.2 MB of JPEG as base64

const PROMPT = `这是一张体重秤显示屏的照片。请读出秤上显示的体重数字和单位。
只返回 JSON，例如 {"weight": 57.2, "unit": "kg"}。
unit 只能是 "kg"、"jin"（斤）、"lb" 或 null（看不出单位）。
如果看不清或照片里没有体重读数，返回 {"weight": null, "unit": null}。`;

class GoogleError extends Error {
    constructor(service, status, body) {
        let info = {};
        try { info = JSON.parse(body).error || {}; } catch { /* non-JSON error body */ }
        const message = info.message || body.slice(0, 200);
        super(`${service} HTTP ${status}: ${message}`);
        this.status = status;
        this.detail = `${service} ${status}${info.status ? ' ' + info.status : ''}: ${message}`.slice(0, 300);
        this.hint = explain(status, `${info.status || ''} ${message}`);
    }
}

// Turn common Google API failures into an actionable hint (shown to the user)
function explain(status, text) {
    if (/API key not valid|API_KEY_INVALID/i.test(text)) return '密钥无效，请检查 Vercel 里填的密钥是否完整正确';
    if (/referer|referrer|ip address|android|ios/i.test(text) && status === 403) return '密钥设置了使用限制（网站/IP），请在 Google 控制台把“应用限制”改为“无”';
    if (/has not been used|is disabled|SERVICE_DISABLED|not enabled/i.test(text)) return '这个密钥所在的 Google 项目没有启用对应的 API';
    if (/API_KEY_SERVICE_BLOCKED|blocked/i.test(text)) return '密钥不允许调用这个 API（API 限制），请检查密钥的“API 限制”设置';
    if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(text)) return 'Google 额度用完了，请稍后再试或检查账单设置';
    if (status === 404) return '模型不可用，可以在 Vercel 设置 GEMINI_MODEL 换一个型号';
    if (/location|region|not supported/i.test(text)) return '当前地区不支持这个服务';
    return '识别服务暂时不可用';
}

function toKg(weight, unit) {
    if (typeof weight !== 'number' || !isFinite(weight)) return null;
    const kg = unit === 'jin' ? weight / 2 : unit === 'lb' ? weight * 0.45359237 : weight;
    return Math.round(kg * 10) / 10;
}

async function readWithGemini(image, key) {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
            contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: image } }, { text: PROMPT }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0 }
        })
    });
    if (!res.ok) throw new GoogleError('Gemini', res.status, await res.text());
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) || '{}');
    const weight = typeof parsed.weight === 'string' ? parseFloat(parsed.weight) : parsed.weight;
    return { weight, unit: parsed.unit ?? null, raw: text };
}

async function readWithVision(image, key) {
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ image: { content: image }, features: [{ type: 'TEXT_DETECTION' }] }] })
    });
    if (!res.ok) throw new GoogleError('Vision', res.status, await res.text());
    const data = await res.json();
    const text = data.responses?.[0]?.fullTextAnnotation?.text || '';
    const unit = /lb/i.test(text) ? 'lb' : /斤/.test(text) ? 'jin' : /kg/i.test(text) ? 'kg' : null;
    // First number that could plausibly be a body weight
    const weight = (text.match(/\d{2,3}(?:[.,]\d{1,2})?/g) || [])
        .map(n => parseFloat(n.replace(',', '.')))
        .find(n => n >= 20 && n <= 500);
    return { weight: weight ?? null, unit, raw: text };
}

async function overLimit(ip) {
    if (!isConfigured()) return false;
    const key = `scale:${ip}`;
    const [count] = await pipeline([['INCR', key]]);
    if (count === 1) await pipeline([['EXPIRE', key, '3600']]);
    return count > MAX_PER_HOUR;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }

    const gemini = process.env.GEMINI_API_KEY;
    const vision = process.env.GOOGLE_VISION_API_KEY;
    if (!gemini && !vision) {
        res.status(503).json({ error: '拍照读数还没有配置' });
        return;
    }

    const image = req.body && typeof req.body.image === 'string' ? req.body.image.replace(/^data:image\/\w+;base64,/, '') : '';
    if (!image || image.length > MAX_IMAGE_CHARS) {
        res.status(400).json({ error: '照片无效或太大' });
        return;
    }

    try {
        if (await overLimit(clientIp(req))) {
            res.status(429).json({ error: '拍得太频繁了，请稍后再试' });
            return;
        }
        const result = gemini ? await readWithGemini(image, gemini) : await readWithVision(image, vision);
        res.status(200).json({ kg: toKg(result.weight, result.unit), weight: result.weight ?? null, unit: result.unit });
    } catch (err) {
        console.error('scale read failed:', err);
        res.status(502).json({
            error: err.hint || '识别服务暂时不可用',
            // Google's own message (never contains the key) so problems can be diagnosed without logs
            detail: err.detail || String(err.message || err).slice(0, 300)
        });
    }
}
