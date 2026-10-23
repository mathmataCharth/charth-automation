'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.cwd(), 'data', 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Create tables
db.exec(`
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL,
    page_count INTEGER,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS access_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    recipient_name TEXT NOT NULL,
    recipient_email TEXT,
    password_hash TEXT NOT NULL,
    max_views INTEGER,
    views_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_access_links_token ON access_links(token);

CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    access_link_id INTEGER NOT NULL REFERENCES access_links(id) ON DELETE CASCADE,
    ip_address TEXT,
    user_agent TEXT,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_access_logs_link ON access_logs(access_link_id);
CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at);

CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Add identifiers to existing installations without changing tokens or passwords.
require('../utils/accessCode').migrateAccessCodes(db);

// Immutable upload files; only the document's active pointer changes on activation.
db.exec(`CREATE TABLE IF NOT EXISTS document_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    stored_filename TEXT NOT NULL UNIQUE,
    original_filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    page_count INTEGER,
    base_filename TEXT,
    status TEXT NOT NULL,
    image_version TEXT,
    storage TEXT,
    sha256 TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    submitted_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_revisions_pending ON document_revisions(document_id)
    WHERE status IN ('queued','validating','preparing');
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_revisions_active ON document_revisions(document_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS document_revision_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision_id INTEGER NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    actor TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

// Jobs survive application and worker restarts; originals and access rows are unchanged.
db.exec(`CREATE TABLE IF NOT EXISTS image_preparations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    access_link_id INTEGER REFERENCES access_links(id) ON DELETE CASCADE,
    job_key TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    storage TEXT NOT NULL DEFAULT 'local',
    status TEXT NOT NULL DEFAULT 'queued',
    completed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_preparations_pending ON image_preparations(status, retry_at, lease_until);`);

if (!db.prepare('PRAGMA table_info(image_preparations)').all().some(column => column.name === 'revision_id')) {
    db.exec('ALTER TABLE image_preparations ADD COLUMN revision_id INTEGER REFERENCES document_revisions(id) ON DELETE CASCADE');
}

module.exports = db;
