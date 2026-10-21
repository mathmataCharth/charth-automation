'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrateAccessCodes, ensureAccessCode, reserveCode } = require('../src/utils/accessCode');

test('existing accesses receive unique five-digit codes without changing credentials or limits', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE access_links (id INTEGER PRIMARY KEY, token TEXT, password_hash TEXT,
        max_views INTEGER, expires_at TEXT, views_count INTEGER);
        INSERT INTO access_links VALUES (1,'old-token','old-hash',20,'2099-12-01',5),
            (2,'other-token','other-hash',NULL,NULL,0);`);
    const before = db.prepare('SELECT * FROM access_links ORDER BY id').all();
    migrateAccessCodes(db);
    const after = db.prepare('SELECT * FROM access_links ORDER BY id').all();
    assert.notEqual(after[0].access_code, after[1].access_code);
    for (let i = 0; i < after.length; i++) {
        const { access_code, ...unchanged } = after[i];
        assert.match(access_code, /^[1-9]\d{4}$/);
        assert.deepEqual(unchanged, before[i]);
    }
    migrateAccessCodes(db);
    assert.deepEqual(db.prepare('SELECT * FROM access_links ORDER BY id').all(), after);
    assert.equal(ensureAccessCode(db, 1), after[0].access_code);
    db.close();
});

test('code collisions are retried and deleted access codes are never reused', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE access_links (id INTEGER PRIMARY KEY)');
    migrateAccessCodes(db);
    assert.equal(reserveCode(db, () => 58391), '58391');
    let calls = 0;
    assert.equal(reserveCode(db, () => ++calls < 3 ? 58391 : 27864), '27864');
    assert.equal(calls, 3);
    db.exec("INSERT INTO access_links (id,access_code) VALUES (1,'58391'); DELETE FROM access_links WHERE id=1;");
    calls = 0;
    assert.equal(reserveCode(db, () => ++calls === 1 ? 58391 : 71603), '71603');
    assert.equal(calls, 2);
    assert.throws(() => reserveCode(db, () => 123), /inválido/);
    db.close();
});
