'use strict';

function versionSequence(code) {
    if (typeof code !== 'string' || !/^A(?:\d{3}|[1-9]\d{3,})$/.test(code)) {
        throw new Error('Código de versão inválido.');
    }
    const sequence = Number(code.slice(1));
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Código de versão inválido.');
    return sequence;
}

function formatVersionLabel(code) {
    versionSequence(code);
    // Editorial collection year; never derived from the current date.
    return `Versão:2027_${code}`;
}

function reserveVersionCode(db) {
    // Never remove these rows: deleted accesses must not free their identifiers.
    const result = db.prepare('INSERT INTO access_version_registry DEFAULT VALUES').run();
    const sequence = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Sequência de versões esgotada.');
    return 'A' + String(sequence).padStart(3, '0');
}

function ensureVersionCode(db, id) {
    return db.transaction(() => {
        const row = db.prepare('SELECT version_code FROM access_links WHERE id = ?').get(id);
        if (!row) return null;
        if (row.version_code) return row.version_code;
        const code = reserveVersionCode(db);
        db.prepare('UPDATE access_links SET version_code = ? WHERE id = ?').run(code, id);
        return code;
    }).immediate();
}

function migrateAccessCodes(db) {
    db.transaction(() => {
        const columns = db.pragma('table_info(access_links)').map(column => column.name);
        // Keep legacy numeric identifiers for photographs shared before this change.
        if (!columns.includes('access_code')) db.exec('ALTER TABLE access_links ADD COLUMN access_code TEXT');
        if (!columns.includes('version_code')) db.exec('ALTER TABLE access_links ADD COLUMN version_code TEXT');
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_access_links_code ON access_links(access_code);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_access_links_version ON access_links(version_code);
            CREATE TABLE IF NOT EXISTS access_version_registry (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence > 0)
            );`);
        const register = db.prepare('INSERT OR IGNORE INTO access_version_registry (sequence) VALUES (?)');
        for (const row of db.prepare('SELECT version_code FROM access_links WHERE version_code IS NOT NULL').all()) {
            register.run(versionSequence(row.version_code));
        }
        const missing = db.prepare('SELECT id FROM access_links WHERE version_code IS NULL ORDER BY id').all();
        const update = db.prepare('UPDATE access_links SET version_code = ? WHERE id = ?');
        for (const row of missing) update.run(reserveVersionCode(db), row.id);
    }).immediate();
}

module.exports = { reserveVersionCode, ensureVersionCode, migrateAccessCodes, formatVersionLabel };
