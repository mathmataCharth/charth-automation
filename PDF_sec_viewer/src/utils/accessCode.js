'use strict';

const crypto = require('crypto');

function reserveCode(db, random = crypto.randomInt) {
    const insert = db.prepare('INSERT OR IGNORE INTO access_code_registry (code) VALUES (?)');
    for (let attempt = 0; attempt < 256; attempt++) {
        const code = String(random(10000, 100000));
        if (!/^[1-9]\d{4}$/.test(code)) throw new Error('Código de acesso inválido.');
        if (insert.run(code).changes === 1) return code;
    }
    throw new Error('Não foi possível gerar um código exclusivo para este acesso.');
}

function ensureAccessCode(db, id) {
    return db.transaction(() => {
        const row = db.prepare('SELECT access_code FROM access_links WHERE id = ?').get(id);
        if (!row) return null;
        if (row.access_code) return row.access_code;
        const code = reserveCode(db);
        db.prepare('UPDATE access_links SET access_code = ? WHERE id = ?').run(code, id);
        return code;
    }).immediate();
}

function migrateAccessCodes(db) {
    db.transaction(() => {
        const exists = db.pragma('table_info(access_links)').some(column => column.name === 'access_code');
        if (!exists) db.exec('ALTER TABLE access_links ADD COLUMN access_code TEXT');
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_access_links_code ON access_links(access_code);
            CREATE TABLE IF NOT EXISTS access_code_registry (
                code TEXT PRIMARY KEY CHECK (code GLOB '[1-9][0-9][0-9][0-9][0-9]')
            );
            INSERT OR IGNORE INTO access_code_registry (code)
                SELECT access_code FROM access_links WHERE access_code IS NOT NULL;`);
        const missing = db.prepare('SELECT id FROM access_links WHERE access_code IS NULL').all();
        const update = db.prepare('UPDATE access_links SET access_code = ? WHERE id = ?');
        for (const row of missing) update.run(reserveCode(db), row.id);
    }).immediate();
}

module.exports = { reserveCode, ensureAccessCode, migrateAccessCodes };
