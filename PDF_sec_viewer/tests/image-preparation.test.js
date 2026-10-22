'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { PDFDocument } = require('pdf-lib');
const { execFileSync } = require('child_process');
const previous = process.cwd(), previousUpload = process.env.UPLOAD_DIR;
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-lookbook-'));
process.chdir(folder);
fs.mkdirSync('data');
process.env.UPLOAD_DIR = folder;
const db = require('../src/config/database');
const { createDocument, deleteDocument } = require('../src/services/documentService');
const { createLink, getLinkById, deleteLink } = require('../src/services/accessService');
const jobs = require('../src/services/imagePreparationService');
const { getPreviewInfo, getReadyImage } = require('../src/services/imagePreviewService');
let documentId, linkId, otherId, source, bytes, server, base, info;
let available = true;
try {
    execFileSync(process.env.QPDF_BIN || 'qpdf', ['--version'], { stdio: 'ignore' });
    execFileSync(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-v'], { stdio: 'ignore' });
} catch (_) { available = false; }

before(async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 300]);
    page.drawText('Original photo quality', { x: 80, y: 150, size: 12 });
    bytes = Buffer.from(await pdf.save());
    source = path.join(folder, 'lookbook.pdf');
    fs.writeFileSync(source, bytes);
    documentId = createDocument('Coleção', 'original.pdf', 'lookbook.pdf', bytes.length, 1);
    linkId = createLink(documentId, 'existing-access', 'Client', '', 'unchanged-password-hash', 1, null);
    otherId = createLink(documentId, 'another-access', 'Other', '', 'other-hash', 5, null);
    const app = express();
    app.use(express.urlencoded({ extended: false })); app.use(express.json());
    app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../views'));
    const session = { viewerTokens: { 'existing-access': true }, viewerOpenings: {} };
    app.use((req, res, next) => {
        req.session = req.get('x-auth') === 'yes' ? session : {};
        if (req.get('x-admin') === 'yes') req.session = { adminId: 1 };
        next();
    });
    app.use('/v', require('../src/routes/viewer'));
    app.use('/api', require('../src/routes/api'));
    app.use('/admin', require('../src/routes/admin'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    base = `http://127.0.0.1:${server.address().port}`;
    info = await getPreviewInfo(source, 1);
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close(); process.chdir(previous);
    if (previousUpload === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = previousUpload;
    fs.rmSync(folder, { recursive: true, force: true });
});
const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
const row = () => db.prepare('SELECT * FROM image_preparations WHERE job_key=?').get(`access:${linkId}`);
const offline = { renderBase: async () => {}, renderMarked: async () => ({ file: 'prepared.webp' }), upload: async () => {} };

test('scheduling is durable, idempotent and never changes access identity or usage', async () => {
    const access = getLinkById(linkId);
    await jobs.scheduleDocument(documentId);
    await jobs.scheduleDocument(documentId);
    assert.equal(jobs.statusForDocument(documentId).length, 3);
    assert.equal(row().version, info.version);
    assert.equal(row().total, 2);
    assert.deepEqual(getLinkById(linkId), access);
    // A second SQLite connection observes the persisted queue (not an in-memory task list).
    const second = new (require('better-sqlite3'))(path.join(folder, 'data/database.sqlite'));
    assert.equal(second.prepare('SELECT COUNT(*) n FROM image_preparations').get().n, 3);
    second.close();
});

test('leases prevent parallel workers and abandoned work becomes available after a crash', () => {
    const current = Date.now();
    const claimed = jobs.claimJob(current);
    assert.ok(claimed);
    assert.equal(jobs.claimJob(current), null);
    const recovered = jobs.claimJob(current + 300001);
    assert.ok(recovered);
    db.prepare("UPDATE image_preparations SET status='queued',lease_until=0").run();
});

test('missing assets return promptly without invoking the converter or exposing original/base bytes', async () => {
    const old = process.env.PDFTOPPM_BIN;
    process.env.PDFTOPPM_BIN = path.join(folder, 'must-never-run');
    try {
        await assert.rejects(getReadyImage(source, getLinkById(linkId).version_code, 1, 'view', info.version, 1), { status: 503 });
        const response = await request(`/admin/links/${linkId}/preview/images/${info.version}/1/view`, { headers: { 'x-admin': 'yes' } });
        assert.equal(response.status, 503);
        assert.match(response.headers.get('content-type'), /json/);
        await response.text();
        assert.ok(!fs.existsSync(source + '.parts/image-preview'));
    } finally { if (old === undefined) delete process.env.PDFTOPPM_BIN; else process.env.PDFTOPPM_BIN = old; }
});

test('background failures retain progress, back off, retry and respect the free-space reserve', async () => {
    const old = process.env.IMAGE_PREPARATION_MIN_FREE_MB;
    process.env.IMAGE_PREPARATION_MIN_FREE_MB = '999999999';
    try {
        await jobs.runNext(offline);
        const failed = db.prepare("SELECT * FROM image_preparations WHERE status='failed'").get();
        assert.equal(failed.completed, 0);
        assert.equal(failed.attempts, 1);
        assert.ok(failed.retry_at > Date.now());
        assert.equal(failed.error, 'DISK_SPACE');
        await jobs.scheduleDocument(documentId, { retry: true });
        assert.equal(db.prepare('SELECT attempts FROM image_preparations WHERE id=?').get(failed.id).attempts, 0);
    } finally { if (old === undefined) delete process.env.IMAGE_PREPARATION_MIN_FREE_MB; else process.env.IMAGE_PREPARATION_MIN_FREE_MB = old; }
});

test('public access stays in PDF until every page and resolution is ready', async () => {
    const response = await request('/v/existing-access/view', { headers: { 'x-auth': 'yes' } });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('data-info="/api/pdf/'));
    assert.equal(getLinkById(linkId).views_count, 1);
    const metadata = await request('/api/images/existing-access/info', { headers: { 'x-auth': 'yes' } });
    assert.equal(metadata.status, 503); await metadata.text();
    const denied = await request('/api/images/existing-access/info');
    assert.equal(denied.status, 401); await denied.text();
});

test('the real background pipeline prepares both resolutions and changes the existing link to images', { skip: !available }, async () => {
    for (let n = 0; n < 6 && await jobs.runNext(); n++) {}
    assert.equal(row().status, 'ready');
    const bases = jobs.statusForDocument(documentId).find(job => job.linkId === null);
    assert.equal(bases.status, 'ready');
    assert.equal(bases.completed, bases.total);
    assert.equal(await jobs.runNext(), false);
    assert.ok(await jobs.readyForLink(getLinkById(linkId), { stored_filename: 'lookbook.pdf', page_count: 1 }));
    assert.deepEqual(fs.readFileSync(source), bytes);
    // Allow a second genuine opening. The image requests themselves must not reserve more.
    db.prepare('UPDATE access_links SET max_views=2 WHERE id=?').run(linkId);
    const response = await request('/v/existing-access/view', { headers: { 'x-auth': 'yes' } });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('data-customer="true"'));
    assert.equal(getLinkById(linkId).views_count, 2);
    for (const profile of ['view', 'detail']) {
        const image = await request(`/api/images/existing-access/images/${info.version}/1/${profile}`, { headers: { 'x-auth': 'yes' } });
        assert.equal(image.status, 200);
        assert.match(image.headers.get('cache-control'), /private, no-store/);
        assert.equal(image.headers.get('server-timing'), 'prepare;dur=0');
        const data = Buffer.from(await image.arrayBuffer());
        const disk = await getReadyImage(source, getLinkById(linkId).version_code, 1, profile, info.version, 1);
        assert.deepEqual(data, fs.readFileSync(disk.file));
    }
    assert.equal(getLinkById(linkId).views_count, 2);
    const exhausted = await request('/v/existing-access/view', { headers: { 'x-auth': 'yes' } });
    assert.equal(exhausted.status, 403); await exhausted.text();
});

test('deactivation and expiration stop subsequent image requests in an already-open session', { skip: !available }, async () => {
    for (const assignment of ['is_active=0', "is_active=1,expires_at='2000-01-01'"]) {
        db.prepare(`UPDATE access_links SET ${assignment} WHERE id=?`).run(linkId);
        const response = await request(`/api/images/existing-access/images/${info.version}/1/view`, { headers: { 'x-auth': 'yes' } });
        assert.equal(response.status, 403); await response.text();
    }
    db.prepare('UPDATE access_links SET is_active=1,expires_at=NULL WHERE id=?').run(linkId);
});

test('Cloudflare grants preserve opening limits and the origin rechecks revocation before cached delivery', { skip: !available }, async () => {
    const media = require('../src/services/edgeMediaService');
    const values = { MEDIA_EDGE_URL: 'https://media.example.com', MEDIA_EDGE_SECRET: 'test-secret-'.repeat(6),
        R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET: 'test-images', R2_ACCESS_KEY_ID: 'test-access', R2_SECRET_ACCESS_KEY: 'test-secret' };
    const old = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
    Object.assign(process.env, values);
    db.prepare('UPDATE image_preparations SET storage=?').run(media.storageIdentity());
    try {
        const image = await request(`/api/images/existing-access/images/${info.version}/1/view`, { headers: { 'x-auth': 'yes' } });
        assert.equal(image.status, 302); await image.text();
        const ticket = new URL(image.headers.get('location')).searchParams.get('ticket');
        const authorize = () => request('/api/media/authorize', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
        let response = await authorize();
        assert.equal(response.status, 204); await response.text();
        db.prepare('UPDATE access_links SET is_active=0 WHERE id=?').run(linkId);
        response = await authorize(); assert.equal(response.status, 403); await response.text();
        db.prepare('UPDATE access_links SET is_active=1 WHERE id=?').run(linkId);
        response = await request('/api/media/authorize', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: 'forged' }) });
        assert.equal(response.status, 401); await response.text();
        assert.equal(getLinkById(linkId).views_count, 2);
    } finally {
        db.prepare("UPDATE image_preparations SET storage='local'").run();
        for (const name of Object.keys(values)) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    }
});

test('an administrator can prioritize one access without changing its credentials or limits', async () => {
    const before = getLinkById(linkId);
    const response = await request(`/admin/links/${linkId}/images/prepare`, { method: 'POST', headers: { 'x-admin': 'yes' } });
    assert.equal(response.status, 302); await response.text();
    assert.ok(row().priority > 0);
    assert.deepEqual(getLinkById(linkId), before);
    const denied = await request(`/admin/links/${linkId}/images/prepare`, { method: 'POST' });
    assert.equal(denied.status, 302);
    assert.equal(denied.headers.get('location'), '/admin/login'); await denied.text();
});

test('a changed source invalidates readiness and restarts the durable preparation without resetting access limits', async () => {
    const before = getLinkById(linkId);
    fs.utimesSync(source, new Date(), new Date(Date.now() + 10000));
    assert.equal(await jobs.readyForLink(before, { stored_filename: 'lookbook.pdf', page_count: 1 }), null);
    await jobs.scheduleDocument(documentId);
    assert.notEqual(row().version, info.version);
    assert.equal(row().status, 'queued');
    assert.equal(row().completed, 0);
    assert.deepEqual(getLinkById(linkId), before);
    db.prepare('UPDATE access_links SET is_active=0 WHERE id=?').run(linkId);
    assert.equal(jobs.statusForDocument(documentId).find(job => job.linkId === linkId).status, 'paused');
    db.prepare('UPDATE access_links SET is_active=1 WHERE id=?').run(linkId);
});

test('deleting links and documents also removes their durable jobs', () => {
    deleteLink(otherId);
    assert.equal(jobs.statusForDocument(documentId).length, 2);
    deleteDocument(documentId);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM image_preparations').get().n, 0);
});
