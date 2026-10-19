import { isConfigured, pipeline, VISITS_KEY, MAX_VISITS } from './_redis.js';
import { clientIp, isExcluded } from './_ip.js';

const header = (req, name) => {
    const v = req.headers[name];
    if (!v) return '';
    try { return decodeURIComponent(v); } catch { return v; }
};

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// Records one visit: IP, time, approximate location (Vercel geo headers), device, page.
export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }

    // Storage not connected yet: accept silently so the page never breaks.
    if (!isConfigured()) {
        res.status(204).end();
        return;
    }

    const ip = clientIp(req);
    if (isExcluded(ip)) {
        res.status(204).end();
        return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const visit = {
        t: new Date().toISOString(),
        ip,
        country: header(req, 'x-vercel-ip-country'),
        region: header(req, 'x-vercel-ip-country-region'),
        city: header(req, 'x-vercel-ip-city'),
        ua: clip(req.headers['user-agent'], 300),
        page: clip(body.page, 40),
        ref: clip(body.ref, 200)
    };

    try {
        await pipeline([
            ['LPUSH', VISITS_KEY, JSON.stringify(visit)],
            ['LTRIM', VISITS_KEY, '0', String(MAX_VISITS - 1)]
        ]);
        res.status(204).end();
    } catch (err) {
        console.error('track failed:', err);
        res.status(500).end();
    }
}
