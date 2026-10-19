// Client IP helpers shared by the API routes.

export function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.headers['x-real-ip']
        || req.socket?.remoteAddress
        || 'unknown';
}

// EXCLUDE_IPS: comma-separated list; an entry ending in "*" matches by prefix
// (e.g. "2001:db8:abcd:*" covers a home IPv6 range whose suffix keeps changing).
function excludeRules() {
    return (process.env.EXCLUDE_IPS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

export function isExcluded(ip) {
    ip = String(ip || '').toLowerCase();
    return excludeRules().some(rule => rule.endsWith('*') ? ip.startsWith(rule.slice(0, -1)) : ip === rule);
}

// Command-line tools, headless browsers, crawlers and link-preview fetchers are not real visitors
const AUTOMATED_UA = /bot|crawl|spider|slurp|headless|curl|wget|python|node-fetch|axios|go-http|java\/|okhttp|facebookexternalhit|preview|lighthouse|vercel|monitor|uptime/i;

export function isAutomated(ua) {
    return !ua || AUTOMATED_UA.test(ua);
}

// EXCLUDE_CITIES: comma-separated city names as reported by Vercel geo (e.g. "San Jose")
export function isExcludedCity(city) {
    const c = String(city || '').trim().toLowerCase();
    if (!c) return false;
    return (process.env.EXCLUDE_CITIES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(c);
}

// One check used both when recording and when listing visits
export function isIgnoredVisit({ ip, ua, city }) {
    return isExcluded(ip) || isAutomated(ua) || isExcludedCity(city);
}
