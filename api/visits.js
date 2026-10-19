import { timingSafeEqual } from 'node:crypto';
import { isConfigured, pipeline, VISITS_KEY, MAX_VISITS } from './_redis.js';

function keyMatches(given) {
    const expected = process.env.STATUS_KEY;
    if (!expected || typeof given !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

// Returns the visit log. Requires the secret STATUS_KEY in the Authorization header.
export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (!process.env.STATUS_KEY) {
        res.status(503).json({ error: '未设置 STATUS_KEY 环境变量' });
        return;
    }

    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!keyMatches(given)) {
        res.status(401).json({ error: '密钥错误' });
        return;
    }

    if (!isConfigured()) {
        res.status(503).json({ error: '尚未连接 Redis 存储' });
        return;
    }

    try {
        const [items] = await pipeline([['LRANGE', VISITS_KEY, '0', String(MAX_VISITS - 1)]]);
        const visits = items.map(s => {
            try { return JSON.parse(s); } catch { return null; }
        }).filter(Boolean);
        res.status(200).json({ visits });
    } catch (err) {
        console.error('visits failed:', err);
        res.status(500).json({ error: '读取失败' });
    }
}
