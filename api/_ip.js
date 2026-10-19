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
