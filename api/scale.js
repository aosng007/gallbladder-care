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
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
    if (!res.ok) throw new Error(`Vision HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
        res.status(502).json({ error: '识别服务暂时不可用' });
    }
}
