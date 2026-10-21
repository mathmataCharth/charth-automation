'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const previousCwd = process.cwd();
const previousUpload = process.env.UPLOAD_DIR;
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-pdf-delete-'));
fs.mkdirSync(path.join(folder, 'data'));
process.chdir(folder);
process.env.UPLOAD_DIR = folder;
// Existing installations have foreign keys without ON DELETE CASCADE.
const setup = new Database(path.join(folder, 'data/database.sqlite'));
setup.exec(`
CREATE TABLE documents (
    id INTEGER PRIMARY KEY, title TEXT, original_filename TEXT, stored_filename TEXT,
    file_size INTEGER, page_count INTEGER, uploaded_at TEXT, is_active INTEGER DEFAULT 1
);
CREATE TABLE access_links (
    id INTEGER PRIMARY KEY, document_id INTEGER REFERENCES documents(id),
    token TEXT, recipient_name TEXT, recipient_email TEXT, password_hash TEXT,
    max_views INTEGER, expires_at TEXT, created_at TEXT, views_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
);
CREATE TABLE access_logs (
    id INTEGER PRIMARY KEY, access_link_id INTEGER REFERENCES access_links(id),
    ip_address TEXT, user_agent TEXT, action TEXT, details TEXT, created_at TEXT
);
`);
setup.close();
const db = require('../src/config/database');
const { createDocument, deleteDocument } = require('../src/services/documentService');
const { createLink, deleteLink } = require('../src/services/accessService');

after(() => {
    db.close();
    process.chdir(previousCwd);
    if (previousUpload === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUpload;
    // Exclusively allocated by mkdtemp above.
    fs.rmSync(folder, { recursive: true, force: true });
});

function fixture(name) {
    const file = path.join(folder, name + '.pdf');
    const original = Buffer.from('%PDF-1.4 original photography ' + name);
    fs.writeFileSync(file, original);
    fs.mkdirSync(file + '.parts');
    fs.writeFileSync(path.join(file + '.parts', 'block.pdf'), original);
    const id = createDocument(name, name + '.pdf', name + '.pdf', original.length, 1);
    const link = createLink(id, name, 'Test', '', 'test-hash', null, null);
    db.prepare("INSERT INTO access_logs (access_link_id,action) VALUES (?,'view_start')").run(link);
    return { id, link, file, original };
}

test('legacy document deletion removes related logs and links without touching another document', () => {
    const target = fixture('target');
    const other = fixture('other');
    assert.equal(db.pragma('foreign_key_list(access_links)')[0].on_delete, 'NO ACTION');
    assert.equal(deleteDocument(target.id), true);
    assert.equal(fs.existsSync(target.file), false);
    assert.equal(fs.existsSync(target.file + '.parts'), false);
    assert.equal(db.prepare('SELECT id FROM documents WHERE id = ?').get(target.id), undefined);
    assert.equal(db.prepare('SELECT id FROM access_links WHERE id = ?').get(target.link), undefined);
    assert.equal(db.prepare('SELECT id FROM access_logs WHERE access_link_id = ?').get(target.link), undefined);
    assert.deepEqual(fs.readFileSync(other.file), other.original);
    assert.ok(db.prepare('SELECT id FROM access_links WHERE id = ?').get(other.link));
    assert.ok(db.prepare('SELECT id FROM access_logs WHERE access_link_id = ?').get(other.link));
});

test('a database rejection rolls back every record and preserves original PDF and blocks', () => {
    const target = fixture('rejected');
    db.exec(`CREATE TRIGGER reject_document_delete BEFORE DELETE ON documents
        BEGIN SELECT RAISE(ABORT, 'simulated deletion failure'); END;`);
    try {
        assert.throws(() => deleteDocument(target.id), /simulated deletion failure/);
        assert.deepEqual(fs.readFileSync(target.file), target.original);
        assert.equal(fs.existsSync(target.file + '.parts'), true);
        assert.ok(db.prepare('SELECT id FROM documents WHERE id = ?').get(target.id));
        assert.ok(db.prepare('SELECT id FROM access_links WHERE id = ?').get(target.link));
        assert.ok(db.prepare('SELECT id FROM access_logs WHERE access_link_id = ?').get(target.link));
    } finally { db.exec('DROP TRIGGER reject_document_delete'); }
});

test('legacy link deletion removes its logs while preserving the document and sibling links', () => {
    const target = fixture('single-link');
    const sibling = createLink(target.id, 'sibling', 'Test', '', 'test-hash', null, null);
    deleteLink(target.link);
    assert.equal(db.prepare('SELECT id FROM access_links WHERE id = ?').get(target.link), undefined);
    assert.equal(db.prepare('SELECT id FROM access_logs WHERE access_link_id = ?').get(target.link), undefined);
    assert.ok(db.prepare('SELECT id FROM access_links WHERE id = ?').get(sibling));
    assert.ok(db.prepare('SELECT id FROM documents WHERE id = ?').get(target.id));
    assert.deepEqual(fs.readFileSync(target.file), target.original);
});

test('a database rejection during link deletion restores its logs', () => {
    const target = fixture('rejected-link');
    db.exec(`CREATE TRIGGER reject_link_delete BEFORE DELETE ON access_links
        BEGIN SELECT RAISE(ABORT, 'simulated link failure'); END;`);
    try {
        assert.throws(() => deleteLink(target.link), /simulated link failure/);
        assert.ok(db.prepare('SELECT id FROM access_links WHERE id = ?').get(target.link));
        assert.ok(db.prepare('SELECT id FROM access_logs WHERE access_link_id = ?').get(target.link));
    } finally { db.exec('DROP TRIGGER reject_link_delete'); }
});
