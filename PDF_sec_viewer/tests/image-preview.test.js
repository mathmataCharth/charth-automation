'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const express = require('express');
const sharp = require('sharp');
const { PDFDocument, degrees, rgb, decodePDFRawStream } = require('pdf-lib');
const { getMarkedImage, getPreviewInfo } = require('../src/services/imagePreviewService');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preview-'));
const cwd = process.cwd(), oldUpload = process.env.UPLOAD_DIR;
process.chdir(folder);
process.env.UPLOAD_DIR = folder;
fs.mkdirSync(path.join(folder, 'data'));
const db = require('../src/config/database');
const { createDocument, deleteDocument } = require('../src/services/documentService');
const { createLink, getLinkById } = require('../src/services/accessService');
let server, base, source, original, documentId, accessId, otherId, info, first;
let available = true;
try {
    execFileSync(process.env.QPDF_BIN || 'qpdf', ['--version'], { stdio: 'ignore' });
    execFileSync(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-v'], { stdio: 'ignore' });
} catch (_) { available = false; }
const real = { skip: !available };

before(async () => {
    const pdf = await PDFDocument.create();
    const pixels = Buffer.alloc(240 * 160 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 17 + Math.floor(i / 240) * 7) % 256;
    const png = await sharp(pixels, { raw: { width: 240, height: 160, channels: 3 } }).png().toBuffer();
    const photo = await pdf.embedPng(png);
    for (const angle of [0, 90, 180, 270]) {
        const page = pdf.addPage([842, 604]);
        page.setCropBox(5, 8, 825, 580);
        page.setRotation(degrees(angle));
        page.drawRectangle({ x: 0, y: 0, width: 842, height: 604, color: rgb(0.96, 0.95, 0.94) });
        page.drawImage(photo, { x: 180, y: 120, width: 480, height: 320 });
        page.drawText('Lookbook detail test', { x: 300, y: 550, size: 12 });
    }
    original = Buffer.from(await pdf.save());
    source = path.join(folder, 'original.pdf');
    fs.writeFileSync(source, original);
    documentId = createDocument('Lookbook', 'original.pdf', 'original.pdf', original.length, 4);
    accessId = createLink(documentId, 'private-customer-token', '<Customer>', '', 'unchanged-hash', 1, '2001-01-01');
    otherId = createLink(documentId, 'other-customer-token', 'Other', '', 'other-hash', null, null);
    db.prepare('UPDATE access_links SET views_count=1,is_active=0 WHERE id=?').run(accessId);
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.resolve(__dirname, '../views'));
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
        req.session = { adminId: req.get('x-test-admin') === '1' ? 1 : undefined,
            viewerTokens: { 'private-customer-token': true } };
        next();
    });
    app.use('/admin', require('../src/routes/admin'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/admin/links/${accessId}/preview`;
    info = await getPreviewInfo(source, 4);
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    process.chdir(cwd);
    if (oldUpload === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = oldUpload;
    // folder is the absolute, dedicated directory returned by mkdtemp above.
    fs.rmSync(folder, { recursive: true, force: true });
});

function admin(route = '', options = {}) {
    return fetch(base + route, { ...options, headers: { 'x-test-admin': '1', ...options.headers } });
}

test('the image pilot and every asset require an admin session, even for an authenticated customer', async () => {
    for (const route of ['', '/info', `/images/${info.version}/1/view`, '/pdf/info', '/pdf/document', '/pdf/parts/invalid/0']) {
        const response = await fetch(base + route, { redirect: 'manual' });
        assert.equal(response.status, route === '' ? 302 : 401, route);
        await response.text();
    }
});

test('the internal screen offers images and PDF without consuming customer limits or adding logs', async () => {
    const before = getLinkById(accessId);
    const logs = db.prepare('SELECT COUNT(*) AS n FROM access_logs').get().n;
    for (const mode of ['', '?mode=pdf']) {
        const response = await admin(mode);
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.ok(html.includes('Não consome visualizações'));
        assert.ok(html.includes('&lt;Customer&gt;'));
        assert.ok(html.includes(`data-mode="${mode ? 'pdf' : 'images'}"`));
    }
    const metadata = await admin('/info');
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).pageCount, 4);
    assert.deepEqual(getLinkById(accessId), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_logs').get().n, logs);
    const missing = await fetch(base.replace(`/${accessId}/`, '/999999/') + '/info', { headers: { 'x-test-admin': '1' } });
    assert.equal(missing.status, 404);
    await missing.text();
});

test('invalid pages, profiles and stale sources are rejected before conversion', async () => {
    for (const [route, status] of [
        [`/images/${info.version}/0/view`, 400], [`/images/${info.version}/5/view`, 404],
        [`/images/${info.version}/1/raw`, 400], [`/images/${'0'.repeat(64)}/1/view`, 409],
        ['/images/invalid/1/view', 400]
    ]) {
        const response = await admin(route);
        assert.equal(response.status, status, route);
        await response.text();
    }
});

test('concurrent image preparation reuses one result and different access codes stay isolated', real, async () => {
    const code = getLinkById(accessId).version_code;
    const [a, b] = await Promise.all([getMarkedImage(source, code, 1, 'view', info.version, 4),
        getMarkedImage(source, code, 1, 'view', info.version, 4)]);
    first = a;
    assert.equal(a.file, b.file);
    assert.equal(a.cacheHit, false);
    assert.equal((await getMarkedImage(source, code, 1, 'view', info.version, 4)).cacheHit, true);
    const other = await getMarkedImage(source, getLinkById(otherId).version_code, 1, 'view', info.version, 4);
    assert.notEqual(other.file, a.file);
    assert.ok(!fs.readFileSync(other.file).equals(fs.readFileSync(a.file)));
    assert.equal(other.base, a.base, 'the expensive unmarked raster is shared privately');
    assert.deepEqual(fs.readFileSync(source), original);
});

test('lossless encoding preserves every rendered pixel outside the three baked-in gray labels', real, async () => {
    const a = await sharp(first.base).raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(first.file).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual(a.info, b.info);
    const { width: w, height: h, channels } = a.info;
    assert.equal(Math.max(w, h), 1800);
    const hits = [0, 0, 0];
    const boxes = [[w / 2 - 100, 0, w / 2 + 100, 40],
        [w * .055 - 25, h / 2 - 100, w * .055 + 10, h / 2 + 100],
        [w - 200, h * .875 - 35, w, h * .875 + 12]];
    let grayPixels = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const offset = (y * w + x) * channels;
        if (a.data.subarray(offset, offset + channels).equals(b.data.subarray(offset, offset + channels))) continue;
        const box = boxes.findIndex(([left, top, right, bottom]) => x >= left && x <= right && y >= top && y <= bottom);
        assert.notEqual(box, -1, `unexpected pixel modification at ${x},${y}`);
        hits[box]++;
        if (b.data[offset] === 119 && b.data[offset + 1] === 119 && b.data[offset + 2] === 119) grayPixels++;
    }
    assert.ok(hits.every(n => n > 50), 'each of the three labels is embedded in the image');
    assert.ok(grayPixels > 30, 'the baked text uses #777777');
});

test('rotation and crop aspect ratios are preserved, and zoom has a separate 4800px image', real, async () => {
    const code = getLinkById(accessId).version_code;
    const rotated = await getMarkedImage(source, code, 2, 'view', info.version, 4);
    const detail = await getMarkedImage(source, code, 1, 'detail', info.version, 4);
    const r = await sharp(rotated.file).metadata(), d = await sharp(detail.file).metadata();
    assert.equal(r.height, 1800);
    assert.ok(Math.abs(r.width / r.height - 580 / 825) < .001);
    assert.equal(d.width, 4800);
    assert.notEqual(detail.file, first.file);
    assert.deepEqual(fs.readFileSync(source), original);
});

test('protected image delivery supports ranges and does not consume any customer views', real, async () => {
    const before = getLinkById(accessId);
    const response = await admin(`/images/${info.version}/1/view`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/webp/);
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    assert.equal(response.headers.get('x-preview-cache'), 'HIT');
    const body = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(body, fs.readFileSync(first.file));
    const range = await admin(`/images/${info.version}/1/view`, { headers: { range: 'bytes=0-63' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), body.subarray(0, 64));
    assert.deepEqual(getLinkById(accessId), before);
});

test('PDF comparison delivers the same individual code through admin-only routes without customer views', real, async () => {
    const before = getLinkById(accessId);
    const manifestResponse = await admin('/pdf/info');
    const metadata = await manifestResponse.json();
    assert.equal(metadata.pageCount, 4);
    assert.ok(metadata.url.startsWith(`/admin/links/${accessId}/preview/pdf/document?revision=`));
    const response = await admin('/pdf/document');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/pdf/);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    for (const page of pdf.getPages()) {
        const content = page.node.Contents().asArray().map(ref => Buffer.from(decodePDFRawStream(pdf.context.lookup(ref)).decode()).toString()).join('\n');
        assert.equal((content.match(/<56657273e36f3a323032375f41303031>/gi) || []).length, 3);
    }
    assert.deepEqual(getLinkById(accessId), before);
});

test('an unprepared page never serves an unmarked image or the original PDF', real, async () => {
    const previous = process.env.PDFTOPPM_BIN;
    process.env.PDFTOPPM_BIN = path.join(folder, 'missing-renderer');
    try {
        const response = await admin(`/images/${info.version}/4/view`);
        assert.equal(response.status, 503);
        assert.match(response.headers.get('content-type'), /application\/json/);
        const body = await response.text();
        assert.ok(!body.includes('%PDF') && !body.includes('RIFF'));
        assert.deepEqual(fs.readFileSync(source), original);
    } finally {
        if (previous === undefined) delete process.env.PDFTOPPM_BIN; else process.env.PDFTOPPM_BIN = previous;
    }
});

test('deleting the document removes private preview images as well as the PDF', real, () => {
    assert.ok(fs.existsSync(source + '.parts/image-preview'));
    deleteDocument(documentId);
    assert.ok(!fs.existsSync(source + '.parts'));
    assert.ok(!fs.existsSync(source));
});
