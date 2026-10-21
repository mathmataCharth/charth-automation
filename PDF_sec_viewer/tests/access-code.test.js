'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrateAccessCodes, ensureVersionCode, reserveVersionCode, formatVersionLabel } = require('../src/utils/accessCode');

test('existing accesses receive fixed sequential versions without changing credentials, limits or legacy codes', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE access_links (id INTEGER PRIMARY KEY, token TEXT, password_hash TEXT,
        max_views INTEGER, expires_at TEXT, views_count INTEGER, access_code TEXT);
        INSERT INTO access_links VALUES (9,'other-token','other-hash',NULL,NULL,0,'27864'),
            (3,'old-token','old-hash',20,'2099-12-01',5,'58391');`);
    const before = db.prepare('SELECT * FROM access_links ORDER BY id').all();
    migrateAccessCodes(db);
    const after = db.prepare('SELECT * FROM access_links ORDER BY id').all();
    assert.deepEqual(after.map(row => row.version_code), ['A001', 'A002']);
    for (let i = 0; i < after.length; i++) {
        const { version_code, ...unchanged } = after[i];
        assert.equal(formatVersionLabel(version_code), `Versão:2027_A00${i + 1}`);
        assert.deepEqual(unchanged, before[i]);
    }
    migrateAccessCodes(db);
    assert.deepEqual(db.prepare('SELECT * FROM access_links ORDER BY id').all(), after);
    assert.equal(ensureVersionCode(db, 3), 'A001');
    assert.equal(ensureVersionCode(db, 9999), null);
    db.close();
});

test('deleted access versions are never reused, including after a restart and after A999', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE access_links (id INTEGER PRIMARY KEY)');
    migrateAccessCodes(db);
    db.exec('INSERT INTO access_links (id) VALUES (1)');
    assert.equal(ensureVersionCode(db, 1), 'A001');
    db.exec('DELETE FROM access_links WHERE id=1');
    migrateAccessCodes(db);
    db.exec('INSERT INTO access_links (id) VALUES (1)');
    assert.equal(ensureVersionCode(db, 1), 'A002');
    db.exec('INSERT INTO access_version_registry (sequence) VALUES (999)');
    assert.equal(reserveVersionCode(db), 'A1000');
    assert.equal(formatVersionLabel('A1000'), 'Versão:2027_A1000');
    assert.equal(db.prepare('SELECT access_code FROM access_links WHERE id=1').get().access_code, null);
    for (const invalid of ['58391', 'A000', 'A1', 'A0001', 'B001', 'A-01', 'A9007199254740992', null]) {
        assert.throws(() => formatVersionLabel(invalid), /inválido/);
    }
    db.close();
});

test('migration from a pre-code database preserves the allocation high-water mark on subsequent migrations', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE access_links (id INTEGER PRIMARY KEY); INSERT INTO access_links VALUES (10)');
    migrateAccessCodes(db);
    assert.equal(ensureVersionCode(db, 10), 'A001');
    db.exec("INSERT INTO access_links (id,version_code) VALUES (20,'A050')");
    migrateAccessCodes(db);
    db.exec('INSERT INTO access_links (id) VALUES (30)');
    assert.equal(ensureVersionCode(db, 30), 'A051');
    db.close();
});
