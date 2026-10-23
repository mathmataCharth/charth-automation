'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const express = require('express');
const { PDFDocument } = require('pdf-lib');
const previous = process.cwd(), previousUpload = process.env.UPLOAD_DIR;
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lookbook-revisions-'));
fs.mkdirSync(path.join(folder, 'data')); process.chdir(folder); process.env.UPLOAD_DIR = folder;
const db = require('../src/config/database');
const documents = require('../src/services/documentService');
const accesses = require('../src/services/accessService');
const revisions = require('../src/services/documentRevisionService');
const jobs = require('../src/services/imagePreparationService');
const { documentVersion } = require('../src/utils/documentVersion');
const { prepareParts } = require('../src/services/pdfPartsService');
let available = true, server, base, id, linkId, disabledId, lateId, original, replacement, revisionId, oldMetadata, newMetadata;
try {
    execFileSync(process.env.QPDF_BIN || 'qpdf', ['--version'], { stdio: 'ignore' });
    execFileSync(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-v'], { stdio: 'ignore' });
} catch (_) { available = false; }
const doc = () => documents.getDocumentById(id);
const rows = () => db.prepare('SELECT * FROM access_links WHERE document_id=? ORDER BY id').all(id);
const events = () => db.prepare('SELECT * FROM access_logs ORDER BY id').all();
const currentRevision = () => revisions.getRevision(revisionId, id);
const request = (route, options = {}) => fetch(base + route, { redirect: 'manual', ...options });
const admin = { 'x-admin': 'yes' }, client = { 'x-client': 'yes' };
async function upload(bytes, expected = documentVersion(doc()), headers = admin) {
    const form = new FormData(); form.append('document_version', expected);
    form.append('pdf', new Blob([bytes], { type: 'application/pdf' }), 'nova-colecao.pdf');
    const response = await request(`/admin/documents/${id}/revisions`, { method: 'POST', headers, body: form });
    const body = await response.text(); return { status: response.status, body };
}
async function finishImages() {
    for (let i = 0; i < 24 && await jobs.runNext(); i++) {}
}
before(async () => {
    async function make(pages, title) {
        const pdf = await PDFDocument.create();
        for (let n = 0; n < pages; n++) pdf.addPage([180, 120]).drawText(title + ' ' + n, { x: 10, y: 60, size: 10 });
        return Buffer.from(await pdf.save());
    }
    original = await make(1, 'Original'); replacement = await make(2, 'Replacement');
    fs.writeFileSync(path.join(folder, 'original.pdf'), original);
    id = documents.createDocument('Collection', 'original.pdf', 'original.pdf', original.length, 1);
    linkId = accesses.createLink(id, 'unchanged-link', 'Client', '', 'unchanged-password-hash', 1, '2099-12-31');
    disabledId = accesses.createLink(id, 'disabled-link', 'Disabled', '', 'disabled-password-hash', 8, null);
    db.prepare('UPDATE access_links SET is_active=0 WHERE id=?').run(disabledId);
    const viewerSession = { viewerTokens: { 'unchanged-link': true }, viewerOpenings: {} };
    const app = express(); app.use(express.urlencoded({ extended: false })); app.use(express.json());
    app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../views'));
    app.use((req, res, next) => {
        req.session = req.get('x-admin') === 'yes' ? { adminId: 1, adminUsername: 'tester' } : req.get('x-client') === 'yes' ? viewerSession : {};
        next();
    });
    app.use('/admin', require('../src/routes/admin')); app.use('/v', require('../src/routes/viewer')); app.use('/api', require('../src/routes/api'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve)); db.close(); process.chdir(previous);
    if (previousUpload === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = previousUpload;
    fs.rmSync(folder, { recursive: true, force: true });
});

test('replacement is admin-only, checks PDF signature and rejects stale forms without retaining unused uploads', async () => {
    const files = fs.readdirSync(folder).filter(name => name.endsWith('.pdf'));
    assert.equal((await upload(replacement, undefined, {})).status, 302);
    assert.equal((await upload(Buffer.from('not a PDF'))).status, 400);
    assert.equal((await upload(replacement, 'stale-source')).status, 409);
    assert.deepEqual(fs.readdirSync(folder).filter(name => name.endsWith('.pdf')), files);
    for (const [route, method] of [[`/documents/${id}/revisions/status`, 'GET'], [`/documents/${id}/revisions/1/cancel`, 'POST']]) {
        const response = await request('/admin' + route, { method }); assert.equal(response.status, 302); await response.text();
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM document_revisions').get().n, 0);
});

test('upload queues an immutable version, serializes competing updates and preserves access rows', async () => {
    const before = rows();
    assert.equal((await upload(replacement)).status, 302);
    revisionId = db.prepare("SELECT id FROM document_revisions WHERE status='queued'").get().id;
    assert.equal((await upload(replacement)).status, 409);
    assert.equal(fs.readdirSync(folder).filter(name => name.endsWith('.pdf')).length, 2);
    assert.equal(doc().stored_filename, 'original.pdf'); assert.deepEqual(rows(), before);
    assert.deepEqual(fs.readFileSync(revisions.sourceFor(currentRevision())), replacement);
    assert.throws(() => revisions.sourceFor({ stored_filename: '../outside.pdf' }));
    const panel = await request(`/admin/documents/${id}`, { headers: admin });
    assert.equal(panel.status, 200); assert.match(await panel.text(), /Atualizar PDF/);
});

test('validation and all background preparation leave the old document live', { skip: !available }, async () => {
    await prepareParts(path.join(folder, 'original.pdf'));
    const open = await request('/v/unchanged-link/view', { headers: client }); assert.equal(open.status, 200); await open.text();
    oldMetadata = await (await request('/api/pdf/unchanged-link/info', { headers: client })).json();
    const before = rows(), logs = events();
    assert.equal(await revisions.runRevisionStep(), true);
    assert.equal(currentRevision().status, 'preparing'); assert.equal(currentRevision().page_count, 2);
    assert.ok(currentRevision().sha256); assert.equal(doc().stored_filename, 'original.pdf');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM image_preparations WHERE revision_id=?').get(revisionId).n, 2, 'disabled accesses do not block activation');
    assert.equal(await revisions.activateIfReady(revisionId), false);
    const old = await request(oldMetadata.parts[0].url, { headers: { ...client, range: 'bytes=0-9' } });
    assert.equal(old.status, 206); await old.arrayBuffer();
    const preview = `/admin/links/${linkId}/preview/revisions/${revisionId}`;
    const denied = await request(preview + '/pdf/info'); assert.equal(denied.status, 401); await denied.text();
    const info = await (await request(preview + '/pdf/info', { headers: admin })).json(); assert.equal(info.pageCount, 2);
    const marked = await request(info.url, { headers: admin }); assert.equal(marked.status, 200); await marked.arrayBuffer();
    const wrong = await request(`/admin/links/${linkId}/preview/revisions/99999/pdf/info`, { headers: admin });
    assert.equal(wrong.status, 404); await wrong.text();
    await finishImages();
    assert.equal(doc().stored_filename, 'original.pdf'); assert.deepEqual(rows(), before); assert.deepEqual(events(), logs);
});

test('an access created during preparation must have its own marked images before activation', { skip: !available }, async () => {
    lateId = accesses.createLink(id, 'late-access', 'New client', '', 'new-password-hash', 3, null);
    assert.equal(await revisions.activateIfReady(revisionId), false);
    await revisions.scheduleRevision(revisionId); await finishImages();
    const job = db.prepare('SELECT * FROM image_preparations WHERE revision_id=? AND access_link_id=?').get(revisionId, lateId);
    assert.equal(job.status, 'ready'); assert.equal(job.completed, 4);
    const { getReadyImage } = require('../src/services/imagePreviewService');
    const first = await getReadyImage(revisions.sourceFor(currentRevision()), accesses.getLinkById(linkId).version_code, 1, 'view', job.version, 2);
    const second = await getReadyImage(revisions.sourceFor(currentRevision()), accesses.getLinkById(lateId).version_code, 1, 'view', job.version, 2);
    assert.notDeepEqual(fs.readFileSync(first.file), fs.readFileSync(second.file));
});

test('a database error rolls back the entire activation; a successful switch changes no access or usage history', { skip: !available }, async () => {
    const before = rows(), logs = events(), prior = db.prepare('SELECT * FROM image_preparations ORDER BY id').all();
    db.exec("CREATE TRIGGER reject_revision BEFORE UPDATE OF stored_filename ON documents BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    await assert.rejects(revisions.activateIfReady(revisionId), /test rollback/);
    db.exec('DROP TRIGGER reject_revision');
    assert.equal(doc().stored_filename, 'original.pdf'); assert.equal(currentRevision().status, 'preparing');
    assert.deepEqual(db.prepare('SELECT * FROM image_preparations ORDER BY id').all(), prior);
    assert.equal(await revisions.activateIfReady(revisionId), true);
    assert.equal(doc().stored_filename, currentRevision().stored_filename); assert.equal(doc().page_count, 2);
    assert.equal(currentRevision().status, 'active'); assert.deepEqual(rows(), before); assert.deepEqual(events(), logs);
    assert.deepEqual(fs.readFileSync(path.join(folder, 'original.pdf')), original);
    assert.deepEqual(fs.readFileSync(revisions.sourceFor(currentRevision())), replacement);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM image_preparations WHERE revision_id IS NULL').get().n, 3);
    await jobs.scheduleDocument(id);
    assert.equal(db.prepare('SELECT status FROM image_preparations WHERE job_key=?').get(`access:${linkId}`).status, 'ready');
});

test('open sessions refresh source metadata without spending a view; stale ranges and image versions are rejected', { skip: !available }, async () => {
    for (const url of [oldMetadata.url, oldMetadata.parts[0].url, '/api/pdf/unchanged-link/document']) {
        const response = await request(url, { headers: client }); assert.equal(response.status, 409); await response.text();
    }
    newMetadata = await (await request('/api/pdf/unchanged-link/info', { headers: client })).json();
    assert.notEqual(newMetadata.version, oldMetadata.version); assert.equal(newMetadata.pageCount, 2);
    const pdf = await request(newMetadata.parts[0].url, { headers: client }); assert.equal(pdf.status, 200); await pdf.arrayBuffer();
    const imageInfo = await (await request('/api/images/unchanged-link/info', { headers: client })).json();
    const stale = await request('/api/images/unchanged-link/images/' + '0'.repeat(64) + '/1/view', { headers: client });
    assert.equal(stale.status, 409); await stale.text();
    const image = await request(`/api/images/unchanged-link/images/${imageInfo.version}/2/detail`, { headers: client });
    assert.equal(image.status, 200); assert.match(image.headers.get('cache-control'), /no-store/); await image.arrayBuffer();
    assert.equal(accesses.getLinkById(linkId).views_count, 1);
    const exhausted = await request('/v/unchanged-link/view', { headers: client }); assert.equal(exhausted.status, 403); await exhausted.text();
    db.prepare('UPDATE access_links SET is_active=0 WHERE id=?').run(linkId);
    const blocked = await request(newMetadata.url, { headers: client }); assert.equal(blocked.status, 403); await blocked.text();
    db.prepare('UPDATE access_links SET is_active=1 WHERE id=?').run(linkId);
});

test('restoration validates the archived file and switches back while retaining the same access data', { skip: !available }, async () => {
    const before = rows(), logs = events();
    const archived = db.prepare("SELECT * FROM document_revisions WHERE document_id=? AND status='archived'").get(id);
    revisions.requestRestore(id, archived.id, documentVersion(doc()), 'tester');
    assert.equal(doc().page_count, 2); await revisions.runRevisionStep(); await finishImages();
    assert.equal(await revisions.activateIfReady(archived.id), true);
    assert.equal(doc().stored_filename, 'original.pdf'); assert.equal(doc().page_count, 1);
    assert.deepEqual(rows(), before); assert.deepEqual(events(), logs);
    assert.deepEqual(fs.readFileSync(path.join(folder, 'original.pdf')), original);
    const preview = await request(`/admin/links/${linkId}/preview/revisions/${revisionId}/pdf/info`, { headers: admin });
    assert.equal(preview.status, 200); assert.equal((await preview.json()).pageCount, 2);
});

test('corrupt, encrypted and disk-starved updates fail safely, with retry and cancellation controls', { skip: !available }, async () => {
    const before = rows(), active = doc().stored_filename;
    async function submit(bytes) {
        assert.equal((await upload(bytes)).status, 302);
        return db.prepare("SELECT id FROM document_revisions WHERE status='queued'").get().id;
    }
    const corrupt = await submit(Buffer.from('%PDF-1.4\ncorrupt'));
    await revisions.runRevisionStep(); assert.equal(revisions.getRevision(corrupt, id).status, 'failed');
    const retry = await request(`/admin/documents/${id}/revisions/${corrupt}/retry`, { method: 'POST', headers: admin });
    assert.equal(retry.status, 302); await retry.text();
    revisions.controlRevision(id, corrupt, 'cancel', 'tester');
    const encryptedFile = path.join(folder, 'encrypted-fixture.pdf');
    execFileSync(process.env.QPDF_BIN || 'qpdf', ['--encrypt', 'user-pass', 'owner-pass', '256', '--', path.join(folder, active), encryptedFile]);
    const encrypted = await submit(fs.readFileSync(encryptedFile)); fs.unlinkSync(encryptedFile);
    await revisions.runRevisionStep(); assert.equal(revisions.getRevision(encrypted, id).status, 'failed');
    const disk = await submit(replacement), previousFloor = process.env.IMAGE_PREPARATION_MIN_FREE_MB;
    process.env.IMAGE_PREPARATION_MIN_FREE_MB = '999999999';
    try { await revisions.runRevisionStep(); } finally {
        if (previousFloor === undefined) delete process.env.IMAGE_PREPARATION_MIN_FREE_MB; else process.env.IMAGE_PREPARATION_MIN_FREE_MB = previousFloor;
    }
    assert.equal(revisions.getRevision(disk, id).status, 'failed');
    assert.match(revisions.getRevision(disk, id).error, /Espaço/);
    assert.equal(doc().stored_filename, active); assert.deepEqual(rows(), before);
});

test('source tampering, worker leases and cancellation cannot activate an incomplete revision', { skip: !available }, async () => {
    assert.equal((await upload(replacement)).status, 302);
    const pending = db.prepare("SELECT * FROM document_revisions WHERE status='queued'").get();
    db.prepare("UPDATE document_revisions SET status='validating',lease_until=?,lease_token='crashed' WHERE id=?").run(Date.now() + 300000, pending.id);
    assert.equal(await revisions.runRevisionStep(), false); assert.equal(jobs.claimJob(), null);
    db.prepare('UPDATE document_revisions SET lease_until=0 WHERE id=?').run(pending.id);
    await revisions.runRevisionStep(); assert.equal(revisions.getRevision(pending.id, id).status, 'preparing');
    await finishImages();
    const file = revisions.sourceFor(pending), stat = fs.statSync(file);
    const changed = Buffer.from(replacement); changed[20] ^= 1; fs.writeFileSync(file, changed); fs.utimesSync(file, stat.atime, stat.mtime);
    assert.equal(await revisions.activateIfReady(pending.id), false);
    // A changed timestamp may invalidate the image version before the SHA guard. Neither path may activate.
    assert.equal(doc().stored_filename, 'original.pdf');
    revisions.controlRevision(id, pending.id, 'cancel', 'tester');
    assert.equal(jobs.claimJob()?.revision_id || null, null);
});

test('document deletion rolls back on database failure and then removes every retained source and job', () => {
    const retained = db.prepare('SELECT stored_filename FROM document_revisions WHERE document_id=?').all(id).map(row => path.join(folder, row.stored_filename));
    db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    assert.throws(() => documents.deleteDocument(id), /test rollback/); db.exec('DROP TRIGGER reject_delete');
    for (const file of retained) assert.ok(fs.existsSync(file));
    assert.ok(rows().length); assert.ok(revisions.revisionsForDocument(id).length);
    documents.deleteDocument(id);
    for (const file of retained) { assert.ok(!fs.existsSync(file)); assert.ok(!fs.existsSync(file + '.parts')); }
    for (const table of ['document_revisions', 'document_revision_events', 'image_preparations', 'access_links']) {
        assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    }
});
