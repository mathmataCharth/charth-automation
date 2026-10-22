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

    const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
    const baseFile = path.resolve(uploadDir, doc.stored_filename);
    if (!baseFile.startsWith(uploadDir + path.sep)) {
        throw new Error('Caminho de documento inválido.');
    }

    // Older databases have NO ACTION foreign keys. Remove children explicitly,
    // in a single transaction, before touching any of the physical files.
    db.transaction(() => {
        db.prepare('DELETE FROM image_preparations WHERE document_id = ?').run(id);
        db.prepare(`DELETE FROM access_logs WHERE access_link_id IN
            (SELECT id FROM access_links WHERE document_id = ?)`).run(id);
        db.prepare('DELETE FROM access_links WHERE document_id = ?').run(id);
        db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    })();

    // Remove the original and any derived files only after the transaction commits.
    for (const suffix of ['', '.compressed', '.linearized']) {
        const p = baseFile + suffix;
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) {
            console.warn(`[DELETE] Falha ao remover ${p}:`, e.message);
        }
    }

    // Derived blocks live only beside this document, inside the upload directory.
    const partsDir = path.resolve(baseFile + '.parts');
    if (partsDir.startsWith(uploadDir + path.sep)) {
        try {
            fs.rmSync(partsDir, { recursive: true, force: true });
        } catch (e) {
            console.warn('[DELETE] Falha ao remover blocos:', e.message);
        }
    }

    return true;
}

module.exports = {
    getAllDocuments,
    getDocumentById,
    createDocument,
    toggleDocument,
    deleteDocument
};
