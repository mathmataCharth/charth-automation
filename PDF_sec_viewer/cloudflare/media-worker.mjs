// Private R2 binding. Authorization always runs BEFORE consulting the edge cache.
const encoder = new TextEncoder();
function decode64(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
async function validTicket(ticket, secret) {
    if (!ticket || ticket.length > 2000 || !secret || secret.length < 32) return false;
    const parts = ticket.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false;
    try {
        const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        return await crypto.subtle.verify('HMAC', key, decode64(parts[1]), encoder.encode('media:' + parts[0]));
    } catch (_) { return false; }
}
function keyFor(claim) { return `prepared/${claim.documentId}/${claim.linkId}/${claim.version}/${claim.page}/${claim.profile}.webp`; }
export default {
    async fetch(request, env, ctx) {
        const origin = request.headers.get('Origin');
        const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer', 'Vary': 'Origin' };
        if (origin === env.APP_ORIGIN) {
            headers['Access-Control-Allow-Origin'] = origin;
            headers['Access-Control-Expose-Headers'] = 'X-Media-Delivery, X-Media-Cache';
        }
        const respond = (body, status) => new Response(body, { status, headers });
        if (request.method !== 'GET' || new URL(request.url).pathname !== '/image') return respond('Not found', 404);
        const ticket = new URL(request.url).searchParams.get('ticket');
        if (!await validTicket(ticket, env.MEDIA_EDGE_SECRET)) return respond('Unauthorized', 401);
        let claim;
        try { claim = JSON.parse(new TextDecoder().decode(decode64(ticket.split('.')[0]))); } catch (_) { return respond('Unauthorized', 401); }
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isSafeInteger(claim.exp) || claim.exp < now || claim.exp > now + 60 ||
            !Number.isSafeInteger(claim.documentId) || claim.documentId < 1 || !Number.isSafeInteger(claim.linkId) || claim.linkId < 1 ||
            !Number.isSafeInteger(claim.page) || claim.page < 1 || !/^[a-f0-9]{64}$/.test(claim.version) ||
            !['view', 'detail'].includes(claim.profile)) return respond('Unauthorized', 401);
        // Fail closed on revocation, expiry, origin/network failure, or deleted assets.
        try {
            const authorization = await fetch(env.APP_ORIGIN + '/api/media/authorize', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }), redirect: 'error',
                signal: AbortSignal.timeout(5000) });
            await authorization.arrayBuffer();
            if (authorization.status !== 204) return respond('Forbidden', 403);
        } catch (_) { return respond('Unavailable', 503); }
        const objectKey = keyFor(claim);
        const cacheKey = new Request(new URL('/private-cache/' + objectKey, request.url), { method: 'GET' });
        let cached = await caches.default.match(cacheKey);
        const hit = Boolean(cached);
        if (!cached) {
            const object = await env.MEDIA.get(objectKey);
            if (!object) return respond('Not found', 404);
            cached = new Response(object.body, { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' } });
            ctx.waitUntil(caches.default.put(cacheKey, cached.clone()));
        }
        return new Response(cached.body, { headers: { ...headers, 'Content-Type': 'image/webp',
            'X-Media-Delivery': 'cloudflare', 'X-Media-Cache': hit ? 'HIT' : 'MISS' } });
    }
};
