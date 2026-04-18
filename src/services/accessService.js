'use strict';

const db = require('../config/database');

function getLinksForDocument(documentId) {
    return db.prepare(`
        SELECT * FROM access_links
        WHERE document_id = ?
        ORDER BY created_at DESC
    `).all(documentId);
}

function getLinkByToken(token) {
    return db.prepare(`
        SELECT
            al.*,
            d.title AS document_title,
            d.stored_filename,
            d.page_count,
            d.is_active AS document_is_active
        FROM access_links al
        JOIN documents d ON d.id = al.document_id
        WHERE al.token = ?
    `).get(token);
}

function createLink(documentId, token, recipientName, recipientEmail, passwordHash, maxViews, expiresAt) {
    const result = db.prepare(`
        INSERT INTO access_links
            (document_id, token, recipient_name, recipient_email, password_hash, max_views, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        documentId,
        token,
        recipientName,
        recipientEmail || null,
        passwordHash,
        maxViews || null,
        expiresAt || null
    );
    return result.lastInsertRowid;
}

function toggleLink(id) {
    db.prepare('UPDATE access_links SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
}

function deleteLink(id) {
    db.prepare('DELETE FROM access_links WHERE id = ?').run(id);
}

function incrementViews(id) {
    db.prepare('UPDATE access_links SET views_count = views_count + 1 WHERE id = ?').run(id);
}

module.exports = {
    getLinksForDocument,
    getLinkByToken,
    createLink,
    toggleLink,
    deleteLink,
    incrementViews
};
