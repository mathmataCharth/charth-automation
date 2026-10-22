'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const media = require('../src/services/edgeMediaService');
const names = ['MEDIA_EDGE_URL', 'MEDIA_EDGE_SECRET', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
const originalFetch = global.fetch, originalCaches = global.caches;
if (!global.crypto) global.crypto = crypto.webcrypto;
function configure() {
    Object.assign(process.env, { MEDIA_EDGE_URL: 'https://media.example.com', MEDIA_EDGE_SECRET: 'test-secret-'.repeat(6),
        R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET: 'test-private-images', R2_ACCESS_KEY_ID: 'test-access-key', R2_SECRET_ACCESS_KEY: 'test-r2-secret' });
}
const image = { documentId: 7, linkId: 28, version: 'b'.repeat(64), page: 2, profile: 'view' };
after(() => {
    global.fetch = originalFetch; global.caches = originalCaches;
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
});

test('delivery is local until the entire Cloudflare configuration is supplied', () => {
    for (const name of names) delete process.env[name];
    assert.equal(media.storageIdentity(), 'local');
    assert.equal(media.edgeUrl(image), null);
    process.env.MEDIA_EDGE_URL = 'https://media.example.com';
    assert.throws(media.configuration, /incompleta/);
    configure();
    assert.match(media.storageIdentity(), /^r2:/);
});

test('media grants are short-lived, bound to the exact access/page/version and tamper-resistant', () => {
    configure();
    const url = media.edgeUrl(image), ticket = new URL(url).searchParams.get('ticket');
    const claim = media.verifyTicket(ticket);
    assert.deepEqual({ ...claim, exp: undefined }, { ...image, exp: undefined });
    assert.ok(claim.exp * 1000 <= Date.now() + 45000);
    assert.equal(media.verifyTicket(ticket, Date.now() + 61000), null);
    const changed = Buffer.from(JSON.stringify({ ...claim, linkId: 29 })).toString('base64url') + '.' + ticket.split('.')[1];
    assert.equal(media.verifyTicket(changed), null);
    assert.equal(media.verifyTicket('invalid'), null);
    assert.equal(media.verifyTicket('x'.repeat(2500)), null);
});

test('R2 uploads send only prepared image bytes with a scoped AWS v4 signature', async () => {
    configure();
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-upload-'));
    const file = path.join(folder, 'image.webp');
    const bytes = Buffer.from('already-marked-image'); fs.writeFileSync(file, bytes);
    let sent;
    global.fetch = async (url, options) => { sent = { url, options }; return new Response('', { status: 200 }); };
    try {
        await media.uploadImage({ ...image, file });
        assert.equal(sent.url, `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/test-private-images/${media.objectKey(image)}`);
        assert.equal(sent.options.method, 'PUT');
        assert.deepEqual(sent.options.body, bytes);
        assert.equal(sent.options.headers['x-amz-content-sha256'], crypto.createHash('sha256').update(bytes).digest('hex'));
        assert.match(sent.options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\/aws4_request,/);
        assert.match(sent.options.headers.authorization, /Signature=[a-f0-9]{64}$/);
        global.fetch = async () => new Response('denied', { status: 403 });
        await assert.rejects(media.uploadImage({ ...image, file }), /R2_UPLOAD_403/);
    } finally { global.fetch = originalFetch; fs.rmSync(folder, { recursive: true, force: true }); }
});

test('the edge verifies revocation before every cache hit and never exposes private cache paths', async () => {
    configure();
    const worker = (await import(pathToFileURL(path.resolve(__dirname, '../cloudflare/media-worker.mjs')).href)).default;
    const cache = new Map(), pending = [];
    let reads = 0, checks = 0, authorized = true;
    global.caches = { default: {
        async match(request) { return cache.get(request.url)?.clone(); },
        async put(request, response) { cache.set(request.url, response.clone()); }
    } };
    global.fetch = async (url, options) => {
        checks++;
        assert.equal(url, 'https://lookbook.example.com/api/media/authorize');
        assert.ok(media.verifyTicket(JSON.parse(options.body).ticket));
        return new Response(null, { status: authorized ? 204 : 403 });
    };
    const env = { APP_ORIGIN: 'https://lookbook.example.com', MEDIA_EDGE_SECRET: process.env.MEDIA_EDGE_SECRET,
        MEDIA: { async get(key) { reads++; return { body: Buffer.from(key) }; } } };
    const ctx = { waitUntil(promise) { pending.push(promise); } };
    const request = new Request(media.edgeUrl(image), { headers: { Origin: env.APP_ORIGIN } });
    try {
        let response = await worker.fetch(request, env, ctx);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), media.objectKey(image));
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.APP_ORIGIN);
        await Promise.all(pending);
        response = await worker.fetch(request, env, ctx);
        assert.equal(response.status, 200); await response.text();
        assert.equal(response.headers.get('X-Media-Cache'), 'HIT');
        assert.equal(reads, 1); assert.equal(checks, 2);
        authorized = false;
        response = await worker.fetch(request, env, ctx);
        assert.equal(response.status, 403); await response.text();
        assert.equal(reads, 1); assert.equal(checks, 3);
        const bypass = await worker.fetch(new Request('https://media.example.com/private-cache/' + media.objectKey(image)), env, ctx);
        assert.equal(bypass.status, 404); await bypass.text();
        const anonymous = await worker.fetch(new Request('https://media.example.com/image'), env, ctx);
        assert.equal(anonymous.status, 401); await anonymous.text();
        authorized = true;
        const second = { ...image, linkId: 29 };
        response = await worker.fetch(new Request(media.edgeUrl(second)), env, ctx);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), media.objectKey(second));
        assert.equal(reads, 2);
        await Promise.all(pending);
        global.fetch = async () => { throw new Error('origin down'); };
        response = await worker.fetch(request, env, ctx);
        assert.equal(response.status, 503); await response.text();
    } finally { global.fetch = originalFetch; global.caches = originalCaches; }
});
