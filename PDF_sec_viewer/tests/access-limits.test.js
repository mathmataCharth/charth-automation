'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { parseAccessLimits, expiryInput, isExpired } = require('../src/utils/accessLimits');
const previousCwd = process.cwd();
const previousUpload = process.env.UPLOAD_DIR;
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'access-limits-'));
fs.mkdirSync(path.join(folder, 'data'));
process.chdir(folder);
process.env.UPLOAD_DIR = folder;
const db = require('../src/config/database');
const { createDocument } = require('../src/services/documentService');
const { createLink, getLinkById } = require('../src/services/accessService');
let server, base, document, link, other;

before(async () => {
    document = createDocument('Lookbook', 'original.pdf', 'original.pdf', 100, 228);
    link = createLink(document, 'existing-token', 'Customer', 'customer@example.com', 'unchanged-hash', 10, '2099-11-04 18:30:00');
    other = createLink(document, 'other-token', 'Other', '', 'other-hash', 8, null);
    db.prepare('UPDATE access_links SET access_code = ? WHERE id = ?').run('58391', link);
    db.prepare('UPDATE access_links SET views_count = 5 WHERE id = ?').run(link);
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.set('view engine', 'ejs');
    app.set('views', path.resolve(__dirname, '../views'));
    app.use((req, res, next) => {
        req.session = { adminId: req.get('x-test-admin') === '1' ? 1 : undefined,
            viewerTokens: { 'existing-token': true }, viewerOpenings: { 'existing-token': true } };
        next();
    });
    app.use('/admin', require('../src/routes/admin'));
    app.use('/api', require('../src/routes/api'));
    app.use('/v', require('../src/routes/viewer'));
    server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    process.chdir(previousCwd);
    if (previousUpload === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUpload;
    fs.rmSync(folder, { recursive: true, force: true });
});

function update(values, { id = link, admin = true } = {}) {
    return fetch(`${base}/admin/links/${id}/limits`, { method: 'POST', redirect: 'manual',
        headers: { 'x-test-admin': admin ? '1' : '0', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values) });
}

test('date editing uses Brasilia time and preserves the instant of legacy UTC deadlines', () => {
    assert.equal(expiryInput('2099-11-04 18:30:00'), '2099-11-04T15:30');
    const beforeTz = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
        const result = parseAccessLimits({ max_views: '20', expires_at: '2099-11-04T15:30' });
        assert.deepEqual(result, { maxViews: 20, expiresAt: '2099-11-04T18:30:00.000Z' });
        assert.equal(expiryInput(result.expiresAt), '2099-11-04T15:30');
        assert.equal(isExpired('2099-11-04 18:30:00', Date.parse('2099-11-04T18:29:59Z')), false);
        assert.equal(isExpired(result.expiresAt, Date.parse('2099-11-04T18:30:00Z')), true);
    } finally {
        if (beforeTz === undefined) delete process.env.TZ;
        else process.env.TZ = beforeTz;
    }
});

test('document panel exposes edit controls with existing limits prefilled', async () => {
    const response = await fetch(`${base}/admin/documents/${document}`, { headers: { 'x-test-admin': '1' } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes('Editar limites'));
    assert.ok(html.includes(`action="/admin/links/${link}/limits"`));
    assert.ok(html.includes('value="2099-11-04T15:30"'));
    assert.ok(html.includes('Já utilizadas: 5'));
    assert.ok(html.includes('2027_A001'));
    assert.ok(html.includes('2027_A002'));
    assert.ok(html.includes('Anterior: 58391'));
    assert.ok(html.includes(`href="/admin/links/${link}/preview"`));
    assert.ok(html.includes('Testar imagens'));
});

test('editing requires admin authentication and unknown links return 404', async () => {
    const before = getLinkById(link);
    const forbidden = await update({ max_views: '20', expires_at: '' }, { admin: false });
    assert.equal(forbidden.status, 302);
    assert.equal(forbidden.headers.get('location'), '/admin/login');
    await forbidden.text();
    assert.deepEqual(getLinkById(link), before);
    const missing = await update({ max_views: '20', expires_at: '' }, { id: 999999 });
    assert.equal(missing.status, 404);
    await missing.text();
});

test('editing changes only limits, preserving URL, password, usage, status, recipient and sibling link', async () => {
    const before = getLinkById(link);
    const sibling = getLinkById(other);
    const response = await update({ max_views: '20', expires_at: '2099-11-04T18:30' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/admin/documents/${document}?updated=${link}#access-links`);
    await response.text();
    assert.deepEqual(getLinkById(link), { ...before, max_views: 20, expires_at: '2099-11-04T21:30:00.000Z' });
    assert.deepEqual(getLinkById(other), sibling);
    const confirmation = await fetch(base + response.headers.get('location'), { headers: { 'x-test-admin': '1' } });
    assert.ok((await confirmation.text()).includes('Limites do acesso atualizados.'));
});

test('invalid limits leave the database untouched and keep the editor open with an error', async () => {
    const before = getLinkById(link);
    for (const values of [
        { max_views: '0', expires_at: '' }, { max_views: '-1', expires_at: '' },
        { max_views: '1.5', expires_at: '' }, { max_views: '1e2', expires_at: '' },
        { max_views: '9007199254740992', expires_at: '' },
        { max_views: '10', expires_at: '2099-02-30T10:00' },
        { max_views: '10', expires_at: 'not-a-date' },
        { max_views: '10', expires_at: '2018-11-04T00:30' }
    ]) {
        const response = await update(values);
        const html = await response.text();
        assert.equal(response.status, 400, JSON.stringify(values));
        assert.ok(html.includes('role="alert"'));
        assert.match(html, new RegExp(`id="edit-link-${link}" class="link-edit-row" >`));
        assert.deepEqual(getLinkById(link), before);
    }
    for (const values of [{ max_views: [], expires_at: '' }, { max_views: '10' }]) {
        const response = await fetch(`${base}/admin/links/${link}/limits`, { method: 'POST',
            headers: { 'x-test-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify(values) });
        assert.equal(response.status, 400);
        await response.text();
        assert.deepEqual(getLinkById(link), before);
    }
});

test('empty fields remove both limits without resetting usage or activating a disabled link', async () => {
    db.prepare('UPDATE access_links SET is_active = 0 WHERE id = ?').run(link);
    const response = await update({ max_views: '', expires_at: '' });
    assert.equal(response.status, 302);
    await response.text();
    const result = getLinkById(link);
    assert.equal(result.max_views, null);
    assert.equal(result.expires_at, null);
    assert.equal(result.views_count, 5);
    assert.equal(result.is_active, 0);
    db.prepare('UPDATE access_links SET is_active = 1 WHERE id = ?').run(link);
});

test('extending limits reopens an exhausted or expired existing link, without replacing it', async () => {
    db.prepare('UPDATE access_links SET max_views = 5 WHERE id = ?').run(link);
    let response = await fetch(base + '/v/existing-token');
    assert.ok((await response.text()).includes('Limite Atingido'));
    response = await update({ max_views: '10', expires_at: '2000-01-01T10:00' });
    await response.text();
    response = await fetch(base + '/api/pdf/existing-token/info');
    assert.equal(response.status, 403);
    await response.text();
    response = await update({ max_views: '10', expires_at: '2099-12-31T23:59' });
    await response.text();
    response = await fetch(base + '/api/pdf/existing-token/info');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pageCount, 228);
    response = await fetch(base + '/v/existing-token');
    assert.equal(response.status, 200);
    const reopened = await response.text();
    assert.ok(reopened.includes('Continuar visualizando'));
    assert.ok(!reopened.includes('Limite Atingido'));
    assert.equal(getLinkById(link).views_count, 5);
});
