// Minimal Upstash Redis REST client (no dependencies).
// Files starting with "_" are not exposed as Vercel routes.
// Accepts the env names set by either the Upstash or the Vercel KV integration.

export const VISITS_KEY = 'visits';
export const MAX_VISITS = 1000;

function config() {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export const isConfigured = () => config() !== null;

// Runs several commands in one round trip; returns each command's result.
export async function pipeline(commands) {
    const { url, token } = config();
    const res = await fetch(`${url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands)
    });
    if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
    const out = await res.json();
    const failed = out.find(r => r.error);
    if (failed) throw new Error(`Redis error: ${failed.error}`);
    return out.map(r => r.result);
}
