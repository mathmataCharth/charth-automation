'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const express = require('express');
const session = require('express-session');
const { pageRanges, readManifest, prepareParts } = require('../src/services/pdfPartsService');

const originalCwd = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-loading-'));
fs.mkdirSync(path.join(temporary, 'data'));
process.chdir(temporary);
process.env.UPLOAD_DIR = temporary;
const db = require('../src/config/database');
const { createDocument, deleteDocument } = require('../src/services/documentService');
const { createLink } = require('../src/services/accessService');
let server, base, cookie, id, file, version;
const preparedUploads = [];
const bytes = Buffer.from('%PDF-1.4\nfixture for authenticated byte range delivery\n%%EOF');

before(async () => {
    file = path.join(temporary, 'fixture.pdf');
    fs.writeFileSync(file, bytes);
    id = createDocument('Lookbook', 'fixture.pdf', 'fixture.pdf', bytes.length, 3);
    createLink(id, 'test-token', 'Test', '', 'unused', 1, null);
    version = randomUUID();
    const folder = path.join(file + '.parts', version);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '0.pdf'), bytes);
    fs.writeFileSync(path.join(folder, '1.pdf'), bytes);
    const stat = fs.statSync(file);
    const manifest = JSON.stringify({ version, source: { size: stat.size, mtimeMs: stat.mtimeMs },
        pageCount: 3, parts: [{ start: 1, end: 1 }, { start: 2, end: 3 }] });
    fs.writeFileSync(path.join(file + '.parts', 'current.json'), manifest);
    fs.writeFileSync(path.join(folder, 'manifest.json'), manifest);
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.resolve(__dirname, '../views'));
    app.use(session({ secret: 'test-only', resave: false, saveUninitialized: false }));
    app.get('/test-login', (req, res) => {
        req.session.viewerTokens = { 'test-token': true };
        req.session.adminId = 1;
        res.end('ok');
    });
    app.use('/v', require('../src/routes/viewer'));
    // These transport tests isolate range handling from PDF generation. The
    // watermark suite exercises the real generator and protected API together.
    const watermarks = require('../src/services/watermarkService');
    const realMarkedPdf = watermarks.getMarkedPdf;
    watermarks.getMarkedPdf = async source => source;
    app.use('/api', require('../src/routes/api'));
    watermarks.getMarkedPdf = realMarkedPdf;
    const partsService = require('../src/services/pdfPartsService');
    const realPrepare = partsService.prepareParts;
    partsService.prepareParts = async (file) => { preparedUploads.push(file); };
    app.use('/admin', require('../src/routes/admin'));
    partsService.prepareParts = realPrepare;
    server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/test-login');
    cookie = login.headers.get('set-cookie').split(';')[0];
    await login.text();
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    process.chdir(originalCwd);
    // temporary is an absolute path allocated exclusively by mkdtemp above.
    fs.rmSync(temporary, { recursive: true, force: true });
});

function request(route, extra = {}) {
    return fetch(base + route, { headers: { cookie, ...extra } });
}

test('228 pages have a small first block and continuous complete numbering', () => {
    const ranges = pageRanges(228);
    assert.equal(ranges.length, 13);
    assert.deepEqual(ranges[0], { start: 1, end: 5 });
    assert.deepEqual(ranges.at(-1), { start: 226, end: 228 });
    assert.deepEqual(ranges.flatMap(({ start, end }) =>
        Array.from({ length: end - start + 1 }, (_, i) => start + i)),
    Array.from({ length: 228 }, (_, i) => i + 1));
    assert.deepEqual(pageRanges(2), [{ start: 1, end: 2 }]);
});

test('metadata and blocks require authentication', async () => {
    for (const route of ['/info', `/parts/${version}/0`, '/document']) {
        const response = await fetch(base + '/api/pdf/test-token' + route);
        assert.equal(response.status, 401);
        await response.text();
    }
});

test('one opening permits all chunks even after reaching the last allowed view', async () => {
    const view = await request('/v/test-token/view');
    assert.equal(view.status, 200);
    await view.text();
    const info = await request('/api/pdf/test-token/info');
    const manifest = await info.json();
    assert.equal(manifest.pageCount, 3);
    assert.equal(manifest.parts.length, 2);
    for (const part of manifest.parts) {
        const response = await request(part.url, { range: 'bytes=0-9' });
        assert.equal(response.status, 206);
        assert.match(response.headers.get('cache-control'), /no-store/);
        assert.equal(response.headers.get('content-range'), `bytes 0-9/${bytes.length}`);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 10));
    }
    assert.equal(db.prepare('SELECT views_count FROM access_links').get().views_count, 1);
    const secondOpen = await request('/v/test-token/view');
    assert.equal(secondOpen.status, 403);
    await secondOpen.text();
});

test('suffix, open-ended, oversize and invalid byte ranges follow HTTP semantics', async () => {
    const route = `/api/pdf/test-token/parts/${version}/0`;
    for (const [range, expected] of [
        ['bytes=-5', bytes.subarray(-5)], ['bytes=10-', bytes.subarray(10)],
        ['bytes=0-999999', bytes]
    ]) {
        const response = await request(route, { range });
        assert.equal(response.status, 206);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    }
    const invalid = await request(route, { range: 'bytes=999999-' });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`);
    await invalid.text();
});

test('invalid versions and missing block files return 404', async () => {
    for (const route of [`/parts/${version}/99`, '/parts/invalid/0']) {
        const response = await request('/api/pdf/test-token' + route);
        assert.equal(response.status, 404);
        await response.text();
    }
    fs.renameSync(path.join(file + '.parts', version, '1.pdf'), path.join(temporary, 'held.pdf'));
    const missing = await request(`/api/pdf/test-token/parts/${version}/1`);
    assert.equal(missing.status, 404);
    await missing.text();
});

test('disabling or expiring a link blocks subsequent chunks in an existing session', async () => {
    db.prepare('UPDATE access_links SET is_active = 0').run();
    assert.equal((await request('/api/pdf/test-token/document')).status, 403);
    db.prepare("UPDATE access_links SET is_active = 1, expires_at = '2000-01-01'").run();
    assert.equal((await request(`/api/pdf/test-token/parts/${version}/0`)).status, 403);
    db.prepare('UPDATE access_links SET expires_at = NULL').run();
    db.prepare('UPDATE documents SET is_active = 0').run();
    assert.equal((await request('/api/pdf/test-token/info')).status, 403);
    db.prepare('UPDATE documents SET is_active = 1').run();
});

test('reprocessed sources fall back to the full PDF while open versions remain readable', async () => {
    fs.appendFileSync(file, '\nupdated');
    assert.equal(readManifest(file), null);
    assert.equal(readManifest(file, version).pageCount, 3);
    const response = await request('/api/pdf/test-token/info');
    const info = await response.json();
    assert.equal(info.parts, null);
    const legacy = await request(info.url);
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.arrayBuffer()).byteLength, bytes.length + 8);
});

test('missing qpdf fails without modifying the original document or active manifest', async () => {
    const original = fs.readFileSync(file);
    const oldManifest = fs.readFileSync(path.join(file + '.parts', 'current.json'));
    const previous = process.env.QPDF_BIN;
    process.env.QPDF_BIN = path.join(temporary, 'nonexistent-qpdf');
    try { await assert.rejects(prepareParts(file)); }
    finally {
        if (previous) process.env.QPDF_BIN = previous;
        else delete process.env.QPDF_BIN;
    }
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(fs.readFileSync(path.join(file + '.parts', 'current.json')), oldManifest);
});

test('deleting a document also removes all its derived blocks', () => {
    assert.equal(deleteDocument(id), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(file + '.parts'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_links').get().n, 0);
});

test('uploads preserve every original byte and prepare only derived files', async () => {
    const upload = new FormData();
    upload.append('title', 'Original photography');
    upload.append('pdf', new Blob([bytes], { type: 'application/pdf' }), 'photography.pdf');
    const response = await fetch(base + '/admin/documents/upload', {
        method: 'POST', headers: { cookie }, body: upload, redirect: 'manual'
    });
    assert.equal(response.status, 302);
    await response.text();
    for (let i = 0; i < 20 && !preparedUploads.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const document = db.prepare("SELECT * FROM documents WHERE title = 'Original photography'").get();
    const file = path.join(temporary, document.stored_filename);
    assert.equal(document.file_size, bytes.length);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(preparedUploads, [file]);
    assert.equal(fs.existsSync(file + '.compressed'), false);
});
