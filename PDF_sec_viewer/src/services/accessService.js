'use strict';

const db = require('../config/database');
const { ensureAccessCode } = require('../utils/accessCode');

function getLinksForDocument(documentId) {
    return db.prepare(`
        SELECT * FROM access_links
        WHERE document_id = ?
        ORDER BY created_at DESC
    `).all(documentId);
}

function getLinkByToken(token) {
    const link = db.prepare(`
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
    if (link && !link.access_code) link.access_code = ensureAccessCode(db, link.id);
    return link;
}

function createLink(documentId, token, recipientName, recipientEmail, passwordHash, maxViews, expiresAt) {
    return db.transaction(() => {
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
        ensureAccessCode(db, result.lastInsertRowid);
        return result.lastInsertRowid;
    })();
}

function toggleLink(id) {
    db.prepare('UPDATE access_links SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
}

function getLinkById(id) {
    return db.prepare('SELECT * FROM access_links WHERE id = ?').get(id);
}

function updateLinkLimits(id, maxViews, expiresAt) {
    return db.prepare('UPDATE access_links SET max_views = ?, expires_at = ? WHERE id = ?')
        .run(maxViews, expiresAt, id).changes === 1;
}

function deleteLink(id) {
    db.transaction(() => {
        db.prepare('DELETE FROM access_logs WHERE access_link_id = ?').run(id);
        db.prepare('DELETE FROM access_links WHERE id = ?').run(id);
    })();
}

function incrementViews(id) {
    db.prepare('UPDATE access_links SET views_count = views_count + 1 WHERE id = ?').run(id);
}

function reserveView(id) {
    return db.prepare(`UPDATE access_links SET views_count = views_count + 1
        WHERE id = ? AND (max_views IS NULL OR max_views = 0 OR views_count < max_views)`)
        .run(id).changes === 1;
}

module.exports = {
    getLinksForDocument,
    getLinkByToken,
    createLink,
    toggleLink,
    getLinkById,
    updateLinkLimits,
    deleteLink,
    incrementViews,
    reserveView
};
