'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../config/database');
const { documentVersion } = require('../utils/documentVersion');
const { getPreviewInfo } = require('./imagePreviewService');
const { prepareParts, readManifest } = require('./pdfPartsService');
const run = promisify(execFile);
const pending = "('queued','validating','preparing')";
const error = (message, status = 409) => Object.assign(new Error(message), { status });

function sourceFor(revision) {
    const root = path.resolve(process.env.UPLOAD_DIR || './uploads');
    const file = path.resolve(root, revision.stored_filename);
    if (!file.startsWith(root + path.sep)) throw error('Caminho de arquivo inválido.', 400);
    return file;
}
function record(revisionId, documentId, action, actor) {
    db.prepare('INSERT INTO document_revision_events(document_id,revision_id,action,actor) VALUES (?,?,?,?)')
        .run(documentId, revisionId, action, actor || null);
}
function currentRevision(doc) {
    let row = db.prepare('SELECT * FROM document_revisions WHERE document_id=? AND stored_filename=?').get(doc.id, doc.stored_filename);
    if (!row) {
        const id = db.prepare(`INSERT INTO document_revisions
            (document_id,stored_filename,original_filename,file_size,page_count,status,created_at,activated_at)
            VALUES (?,?,?,?,?,'active',?,?)`).run(doc.id, doc.stored_filename, doc.original_filename,
                doc.file_size, doc.page_count, doc.uploaded_at, doc.uploaded_at).lastInsertRowid;
        row = db.prepare('SELECT * FROM document_revisions WHERE id=?').get(id);
    }
    return row;
}
function createRevision(documentId, upload, expectedVersion, actor) {
    return db.transaction(() => {
        const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(documentId);
        if (!doc) throw error('Documento não encontrado.', 404);
        if (documentVersion(doc) !== expectedVersion) throw error('O documento já foi atualizado. Atualize o painel antes de enviar outro PDF.');
        if (db.prepare(`SELECT id FROM document_revisions WHERE document_id=? AND status IN ${pending}`).get(documentId)) {
            throw error('Já existe uma atualização em preparação para este documento.');
        }
        sourceFor({ stored_filename: upload.filename });
        currentRevision(doc);
        const id = db.prepare(`INSERT INTO document_revisions
            (document_id,stored_filename,original_filename,file_size,base_filename,status,submitted_by)
            VALUES (?,?,?,?,?,'queued',?)`).run(doc.id, upload.filename, upload.originalname, upload.size, doc.stored_filename, actor || null).lastInsertRowid;
        record(id, doc.id, 'submitted', actor);
        return id;
    }).immediate();
}
function requestRestore(documentId, revisionId, expectedVersion, actor) {
    return db.transaction(() => {
        const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(documentId);
        const revision = db.prepare('SELECT * FROM document_revisions WHERE id=? AND document_id=?').get(revisionId, documentId);
        if (!doc || !revision) throw error('Versão não encontrada.', 404);
        if (documentVersion(doc) !== expectedVersion) throw error('O documento mudou. Atualize o painel.');
        if (revision.status !== 'archived') throw error('Selecione uma versão anterior publicada.');
        if (db.prepare(`SELECT id FROM document_revisions WHERE document_id=? AND status IN ${pending}`).get(documentId)) throw error('Já existe uma atualização em preparação.');
        if (!fs.existsSync(sourceFor(revision))) throw error('O arquivo desta versão não está disponível.', 404);
        db.prepare(`UPDATE document_revisions SET base_filename=?,status='queued',error=NULL,attempts=0,retry_at=0,
            lease_until=0,lease_token=NULL,submitted_by=? WHERE id=?`).run(doc.stored_filename, actor || null, revision.id);
        record(revision.id, doc.id, 'restore_requested', actor);
        return revision.id;
    }).immediate();
}
function controlRevision(documentId, revisionId, action, actor) {
    return db.transaction(() => {
        const row = db.prepare('SELECT * FROM document_revisions WHERE id=? AND document_id=?').get(revisionId, documentId);
        const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(documentId);
        if (!row || !doc) throw error('Versão não encontrada.', 404);
        if (action === 'cancel') {
            if (!['queued', 'validating', 'preparing', 'failed'].includes(row.status)) throw error('Esta atualização já foi concluída.');
            // Keep any in-flight lease until its worker finishes; never interrupt a live PDF.
            db.prepare("UPDATE document_revisions SET status='cancelled',error=NULL WHERE id=?").run(row.id);
        } else {
            if (row.status !== 'failed' || row.base_filename !== doc.stored_filename) throw error('Esta versão não pode ser retomada.');
            if (db.prepare(`SELECT id FROM document_revisions WHERE document_id=? AND status IN ${pending}`).get(documentId)) throw error('Já existe outra atualização em preparação.');
            db.prepare(`UPDATE document_revisions SET status='queued',attempts=0,retry_at=0,error=NULL,
                lease_until=0,lease_token=NULL WHERE id=?`).run(row.id);
        }
        record(row.id, documentId, action === 'cancel' ? 'cancelled' : 'retry_requested', actor);
    }).immediate();
}
function revisionsForDocument(documentId) {
    return db.prepare(`SELECT r.id,r.original_filename,r.file_size,r.page_count,r.status,r.error,r.created_at,r.activated_at,
        COALESCE(SUM(j.completed),0) completed,COALESCE(SUM(j.total),0) total
        FROM document_revisions r LEFT JOIN image_preparations j ON j.revision_id=r.id
            AND (j.access_link_id IS NULL OR j.access_link_id IN (SELECT id FROM access_links WHERE is_active=1))
        WHERE r.document_id=? GROUP BY r.id ORDER BY r.id DESC`).all(documentId);
}
function getRevision(id, documentId) {
    return db.prepare('SELECT * FROM document_revisions WHERE id=? AND document_id=?').get(id, documentId);
}
async function digestFile(file) {
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    return digest.digest('hex');
}
function diskSpace(file) {
    const disk = fs.statfsSync(path.dirname(file));
    const requested = Number(process.env.IMAGE_PREPARATION_MIN_FREE_MB || 2048);
    const minimum = (Number.isFinite(requested) && requested >= 256 ? requested : 2048) * 1048576;
    if (disk.bavail * disk.bsize < minimum) throw error('Espaço livre insuficiente para preparar a atualização.', 503);
}
async function scheduleRevision(id, { retry = false } = {}) {
    const revision = db.prepare("SELECT * FROM document_revisions WHERE id=? AND status='preparing'").get(id);
    if (!revision) return;
    const info = await getPreviewInfo(sourceFor(revision), revision.page_count);
    const storage = require('./edgeMediaService').storageIdentity();
    return db.transaction(() => {
        if (!db.prepare("SELECT id FROM document_revisions WHERE id=? AND status='preparing'").get(id)) return;
        const links = db.prepare('SELECT id FROM access_links WHERE document_id=? AND is_active=1').all(revision.document_id);
        for (const linkId of [null, ...links.map(row => row.id)]) {
            const key = `revision:${id}:` + (linkId ? `access:${linkId}` : `document:${revision.document_id}`);
            db.prepare(`INSERT INTO image_preparations
                (document_id,access_link_id,job_key,version,storage,total,priority,updated_at,revision_id) VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(job_key) DO UPDATE SET version=excluded.version,storage=excluded.storage,status='queued',completed=0,
                    total=excluded.total,attempts=0,retry_at=0,lease_until=0,error=NULL,updated_at=excluded.updated_at
                WHERE image_preparations.version<>excluded.version OR image_preparations.storage<>excluded.storage`)
                .run(revision.document_id, linkId, key, info.version, storage, info.pageCount * 2, Date.now(), Date.now(), id);
            if (retry) db.prepare(`UPDATE image_preparations SET status='queued',attempts=0,retry_at=0,error=NULL
                WHERE job_key=? AND status='failed' AND lease_until<?`).run(key, Date.now());
        }
        db.prepare('UPDATE document_revisions SET image_version=?,storage=? WHERE id=?').run(info.version, storage, id);
        return info;
    }).immediate();
}
async function activateIfReady(id) {
    const revision = db.prepare("SELECT * FROM document_revisions WHERE id=? AND status='preparing'").get(id);
    if (!revision) return false;
    const info = await getPreviewInfo(sourceFor(revision), revision.page_count);
    if (info.version !== revision.image_version || !readManifest(sourceFor(revision))) return false;
    const unfinished = db.prepare(`SELECT 1 FROM access_links al WHERE al.document_id=? AND al.is_active=1 AND NOT EXISTS
        (SELECT 1 FROM image_preparations j WHERE j.revision_id=? AND j.access_link_id=al.id AND j.status='ready') LIMIT 1`)
        .get(revision.document_id, id);
    const basesReady = db.prepare("SELECT id FROM image_preparations WHERE revision_id=? AND access_link_id IS NULL AND status='ready'").get(id);
    if (unfinished || !basesReady) return false;
    if (!revision.sha256 || await digestFile(sourceFor(revision)) !== revision.sha256) {
        db.prepare("UPDATE document_revisions SET status='failed',error=? WHERE id=? AND status='preparing'")
            .run('O arquivo mudou após a validação. A versão atual foi preservada.', id);
        return false;
    }
    return db.transaction(() => {
        const next = db.prepare("SELECT * FROM document_revisions WHERE id=? AND status='preparing'").get(id);
        const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(revision.document_id);
        if (!next || !doc) return false;
        if (doc.stored_filename !== next.base_filename) {
            db.prepare("UPDATE document_revisions SET status='failed',error=? WHERE id=?").run('O documento mudou durante a preparação. Envie a atualização novamente.', id);
            return false;
        }
        if (db.prepare('SELECT id FROM image_preparations WHERE lease_until>? LIMIT 1').get(Date.now()) ||
            db.prepare('SELECT id FROM document_revisions WHERE lease_until>? LIMIT 1').get(Date.now())) return false;
        const base = db.prepare(`SELECT id FROM image_preparations WHERE revision_id=? AND access_link_id IS NULL
            AND status='ready' AND version=? AND storage=?`).get(id, info.version, next.storage);
        const missing = db.prepare(`SELECT al.id FROM access_links al WHERE al.document_id=? AND al.is_active=1 AND NOT EXISTS
            (SELECT 1 FROM image_preparations j WHERE j.revision_id=? AND j.access_link_id=al.id
                AND j.status='ready' AND j.version=? AND j.storage=?) LIMIT 1`).get(doc.id, id, info.version, next.storage);
        if (!base || missing) return false;
        const old = currentRevision(doc);
        db.prepare("UPDATE document_revisions SET status='archived' WHERE id=?").run(old.id);
        db.prepare(`UPDATE image_preparations SET job_key='revision:'||?||':'||job_key,revision_id=?
            WHERE document_id=? AND revision_id IS NULL`).run(old.id, old.id, doc.id);
        db.prepare(`UPDATE documents SET stored_filename=?,original_filename=?,file_size=?,page_count=?
            WHERE id=? AND stored_filename=?`).run(next.stored_filename, next.original_filename, next.file_size, next.page_count, doc.id, next.base_filename);
        db.prepare(`UPDATE image_preparations SET job_key=CASE WHEN access_link_id IS NULL THEN 'document:'||document_id
            ELSE 'access:'||access_link_id END,revision_id=NULL WHERE revision_id=?`).run(id);
        db.prepare("UPDATE document_revisions SET status='active',activated_at=datetime('now'),error=NULL WHERE id=?").run(id);
        record(id, doc.id, 'activated', next.submitted_by);
        return true;
    }).immediate();
}

async function runRevisionStep() {
    const now = Date.now();
    const claimed = db.transaction(() => {
        if (db.prepare('SELECT id FROM image_preparations WHERE lease_until>? LIMIT 1').get(now) ||
            db.prepare('SELECT id FROM document_revisions WHERE lease_until>? LIMIT 1').get(now)) return null;
        const revision = db.prepare(`SELECT * FROM document_revisions WHERE status IN ('queued','validating')
            AND lease_until<=? AND retry_at<=? ORDER BY id LIMIT 1`).get(now, now);
        if (!revision) return null;
        const token = crypto.randomUUID();
        db.prepare("UPDATE document_revisions SET status='validating',lease_until=?,lease_token=? WHERE id=?")
            .run(now + 300000, token, revision.id);
        return { ...revision, lease_token: token };
    }).immediate();
    if (claimed) {
        // A heartbeat extends ownership during long qpdf work without blocking HTTP.
        const heartbeat = setInterval(() => db.prepare(`UPDATE document_revisions SET lease_until=? WHERE id=? AND lease_token=?`)
            .run(Date.now() + 300000, claimed.id, claimed.lease_token), 10000);
        try {
            const source = sourceFor(claimed); diskSpace(source);
            if (fs.statSync(source).size !== claimed.file_size) throw error('O tamanho do arquivo mudou. Envie o PDF novamente.', 400);
            const beforeHash = await digestFile(source);
            if (claimed.sha256 && beforeHash !== claimed.sha256) throw error('O arquivo desta versão foi alterado. Envie o PDF novamente.', 400);
            try { await run(process.env.QPDF_BIN || 'qpdf', ['--check', source], { timeout: 120000, maxBuffer: 1048576 }); }
            catch (e) { if (e.code !== 3) throw error('O PDF está inválido, incompleto ou protegido por senha.', 400); }
            let encrypted = true;
            try { await run(process.env.QPDF_BIN || 'qpdf', ['--is-encrypted', source], { timeout: 30000 }); }
            catch (e) { if (e.code === 2) encrypted = false; else throw e; }
            if (encrypted) throw error('Envie um PDF sem criptografia ou senha de abertura.', 400);
            const manifest = await prepareParts(source);
            const sha256 = await digestFile(source);
            if (sha256 !== beforeHash) throw error('O arquivo mudou durante a validação. Envie o PDF novamente.', 400);
            db.prepare(`UPDATE document_revisions SET page_count=?,sha256=?,status='preparing',error=NULL,
                lease_until=0,lease_token=NULL WHERE id=? AND lease_token=? AND status='validating'`)
                .run(manifest.pageCount, sha256, claimed.id, claimed.lease_token);
            await scheduleRevision(claimed.id, { retry: true });
        } catch (e) {
            const message = e.status ? e.message : 'Não foi possível preparar o PDF. A versão atual foi preservada. Tente novamente.';
            db.prepare(`UPDATE document_revisions SET status='failed',error=?,attempts=attempts+1,
                lease_until=0,lease_token=NULL WHERE id=? AND lease_token=? AND status='validating'`)
                .run(message, claimed.id, claimed.lease_token);
        } finally {
            clearInterval(heartbeat);
            db.prepare('UPDATE document_revisions SET lease_until=0,lease_token=NULL WHERE id=? AND lease_token=?').run(claimed.id, claimed.lease_token);
        }
        return true;
    }
    for (const row of db.prepare("SELECT id FROM document_revisions WHERE status='preparing' ORDER BY id").all()) {
        try {
            await scheduleRevision(row.id);
            const failed = db.prepare("SELECT error FROM image_preparations WHERE revision_id=? AND status='failed' AND attempts>=5 LIMIT 1").get(row.id);
            if (failed) {
                db.prepare("UPDATE document_revisions SET status='failed',error=? WHERE id=? AND status='preparing'")
                    .run(failed.error === 'DISK_SPACE' ? 'Espaço livre insuficiente. A versão atual foi preservada.' : 'A preparação das imagens foi interrompida. A versão atual foi preservada.', row.id);
            } else if (await activateIfReady(row.id)) return true;
        } catch (_) {
            db.prepare("UPDATE document_revisions SET status='failed',error=? WHERE id=? AND status='preparing'")
                .run('Não foi possível concluir a preparação. A versão atual foi preservada.', row.id);
        }
    }
    return false;
}
module.exports = { createRevision, requestRestore, controlRevision, revisionsForDocument, getRevision,
    scheduleRevision, activateIfReady, runRevisionStep, sourceFor };
