'use strict';

const crypto = require('crypto');
const fs = require('fs');
const variables = ['MEDIA_EDGE_URL', 'MEDIA_EDGE_SECRET', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
function configuration() {
    const values = variables.map(name => process.env[name] || '');
    if (!values.some(Boolean)) return null;
    if (values.some(value => !value)) throw new Error('Configuração de entrega de imagens incompleta.');
    const url = new URL(values[0]);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
        !/^[a-f0-9]{32}$/.test(values[2]) || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(values[3]) || values[1].length < 32) {
        throw new Error('Configuração de entrega de imagens inválida.');
    }
    return { origin: url.origin, secret: values[1], account: values[2], bucket: values[3], accessKey: values[4], secretKey: values[5] };
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => crypto.createHmac('sha256', key).update(value).digest(encoding);
function storageIdentity() {
    const config = configuration();
    return config ? 'r2:' + sha(config.account + '/' + config.bucket).slice(0, 24) : 'local';
}
function objectKey({ documentId, linkId, version, page, profile }) {
    return `prepared/${documentId}/${linkId}/${version}/${page}/${profile}.webp`;
}
async function uploadImage(image) {
    const config = configuration();
    if (!config) return;
    const body = await fs.promises.readFile(image.file);
    const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = stamp.slice(0, 8), scope = `${date}/auto/s3/aws4_request`;
    const host = `${config.account}.r2.cloudflarestorage.com`;
    const uri = '/' + [config.bucket, ...objectKey(image).split('/')].map(encodeURIComponent).join('/');
    const payloadHash = sha(body);
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = `PUT\n${uri}\n\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${stamp}\n\n${signedHeaders}\n${payloadHash}`;
    const signingKey = hmac(hmac(hmac(hmac('AWS4' + config.secretKey, date), 'auto'), 's3'), 'aws4_request');
    const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha(canonical)}`, 'hex');
    const response = await fetch(`https://${host}${uri}`, { method: 'PUT', body,
        headers: { 'content-type': 'image/webp', 'x-amz-date': stamp, 'x-amz-content-sha256': payloadHash,
            authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
        signal: AbortSignal.timeout(90000) });
    await response.arrayBuffer();
    if (!response.ok) throw new Error('R2_UPLOAD_' + response.status);
}
function edgeUrl(image) {
    const config = configuration();
    if (!config) return null;
    const payload = Buffer.from(JSON.stringify({ ...image, exp: Math.floor(Date.now() / 1000) + 45 })).toString('base64url');
    const signature = hmac(config.secret, 'media:' + payload, 'base64url');
    return `${config.origin}/image?ticket=${payload}.${signature}`;
}
function verifyTicket(ticket, now = Date.now()) {
    const config = configuration();
    if (!config || typeof ticket !== 'string' || ticket.length > 2000) return null;
    const parts = ticket.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
    const expected = hmac(config.secret, 'media:' + parts[0]);
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    try {
        const claim = JSON.parse(Buffer.from(parts[0], 'base64url'));
        if (!Number.isSafeInteger(claim.exp) || claim.exp * 1000 < now || claim.exp * 1000 > now + 60000 ||
            !Number.isSafeInteger(claim.documentId) || claim.documentId < 1 ||
            !Number.isSafeInteger(claim.linkId) || claim.linkId < 1 || !Number.isSafeInteger(claim.page) || claim.page < 1 ||
            !/^[a-f0-9]{64}$/.test(claim.version) || !['view', 'detail'].includes(claim.profile)) return null;
        return claim;
    } catch (_) { return null; }
}
module.exports = { configuration, storageIdentity, objectKey, uploadImage, edgeUrl, verifyTicket };
