'use strict';

const fs = require('fs');
const path = require('path');
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
    const doc = db.prepare('SELECT stored_filename FROM documents WHERE id = ?').get(id);
    if (!doc) return false;

    // Apaga o arquivo físico (e qualquer .compressed/.linearized residual)
    const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
    const baseFile = path.join(uploadDir, doc.stored_filename);
    for (const suffix of ['', '.compressed', '.linearized']) {
        const p = baseFile + suffix;
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) {
            console.warn(`[DELETE] Falha ao remover ${p}:`, e.message);
        }
    }

    // Remove do banco — FK ON DELETE CASCADE limpa access_links e access_logs
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    return true;
}

module.exports = {
    getAllDocuments,
    getDocumentById,
    createDocument,
    toggleDocument,
    deleteDocument
};
