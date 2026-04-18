'use strict';

const db = require('../config/database');

function getAllDocuments() {
    return db.prepare(`
        SELECT
            d.*,
            COUNT(CASE WHEN al.is_active = 1 THEN 1 END) AS active_links_count
        FROM documents d
        LEFT JOIN access_links al ON al.document_id = d.id
        GROUP BY d.id
        ORDER BY d.uploaded_at DESC
    `).all();
}

function getDocumentById(id) {
    return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

function createDocument(title, originalFilename, storedFilename, fileSize, pageCount) {
    const result = db.prepare(`
        INSERT INTO documents (title, original_filename, stored_filename, file_size, page_count)
        VALUES (?, ?, ?, ?, ?)
    `).run(title, originalFilename, storedFilename, fileSize, pageCount || null);
    return result.lastInsertRowid;
}

function toggleDocument(id) {
    db.prepare('UPDATE documents SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
}

function deleteDocument(id) {
    db.prepare('UPDATE documents SET is_active = 0 WHERE id = ?').run(id);
}

module.exports = {
    getAllDocuments,
    getDocumentById,
    createDocument,
    toggleDocument,
    deleteDocument
};
