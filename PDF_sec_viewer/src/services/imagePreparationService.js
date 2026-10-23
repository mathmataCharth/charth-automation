'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { getPreviewInfo, getMarkedImage, prepareBaseImage } = require('./imagePreviewService');

function sourceFor(doc) {
    const root = path.resolve(process.env.UPLOAD_DIR || './uploads');
    const source = path.resolve(root, doc.stored_filename);
    if (!source.startsWith(root + path.sep)) throw new Error('Caminho de documento inválido.');
    return source;
}

async function scheduleDocument(id, { retry = false } = {}) {
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(id);
    if (!doc) return;
    const info = await getPreviewInfo(sourceFor(doc), doc.page_count);
    const storage = require('./edgeMediaService').storageIdentity();
    const links = db.prepare('SELECT id FROM access_links WHERE document_id=?').all(id);
    const now = Date.now();
    db.transaction(() => {
        // Recheck existence after the asynchronous file inspection (document deletion).
        if (db.prepare('SELECT stored_filename FROM documents WHERE id=?').get(id)?.stored_filename !== doc.stored_filename) return;
        if (!doc.page_count) db.prepare('UPDATE documents SET page_count=? WHERE id=? AND page_count IS NULL').run(info.pageCount, id);
        for (const linkId of [null, ...links.map(row => row.id)]) {
            if (linkId && !db.prepare('SELECT id FROM access_links WHERE id=? AND document_id=?').get(linkId, id)) continue;
            const key = linkId ? `access:${linkId}` : `document:${id}`;
            db.prepare(`INSERT INTO image_preparations
                (document_id,access_link_id,job_key,version,storage,total,updated_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(job_key) DO UPDATE SET version=excluded.version, storage=excluded.storage,
                    status='queued', completed=0,total=excluded.total,attempts=0,retry_at=0,lease_until=0,error=NULL,updated_at=excluded.updated_at
                WHERE image_preparations.version<>excluded.version OR image_preparations.storage<>excluded.storage`)
                .run(id, linkId, key, info.version, storage, info.pageCount * 2, now);
            if (retry) db.prepare(`UPDATE image_preparations SET status='queued',attempts=0,retry_at=0,lease_until=0,error=NULL
                WHERE job_key=? AND status='failed' AND lease_until<?`).run(key, now);
        }
    })();
    return info;
}

async function reconcile() {
    for (const row of db.prepare('SELECT id FROM documents WHERE is_active=1').all()) {
        try { await scheduleDocument(row.id); }
        catch (error) { console.warn('[IMAGES] Não foi possível agendar documento', row.id, error.code || error.status || 'error'); }
    }
}

function statusForDocument(id) {
    return db.prepare(`SELECT j.access_link_id AS linkId,
        CASE WHEN j.status<>'ready' AND (d.is_active=0 OR al.is_active=0) THEN 'paused' ELSE j.status END AS status,
        j.completed,j.total,j.error FROM image_preparations j JOIN documents d ON d.id=j.document_id
        LEFT JOIN access_links al ON al.id=j.access_link_id WHERE j.document_id=? AND j.revision_id IS NULL ORDER BY j.id`).all(id).map(row => ({ ...row,
        error: row.error ? 'A preparação foi interrompida. Tente novamente ou verifique o espaço disponível.' : null }));
}

async function readyForLink(link, doc) {
    const row = db.prepare("SELECT * FROM image_preparations WHERE job_key=? AND status='ready'").get(`access:${link.id}`);
    if (!row) return null;
    const info = await getPreviewInfo(sourceFor(doc), doc.page_count);
    return row.version === info.version ? info : null;
}

function repairLink(id) {
    db.prepare(`UPDATE image_preparations SET status='queued',completed=0,attempts=0,retry_at=0,lease_until=0,error=NULL,updated_at=?
        WHERE job_key=? AND status='ready'`).run(Date.now(), `access:${id}`);
}

function prioritizeLink(id) {
    db.prepare("UPDATE image_preparations SET priority=? WHERE job_key=?").run(Date.now(), `access:${id}`);
}

function claimJob(now = Date.now()) {
    return db.transaction(() => {
        const row = db.prepare(`SELECT j.*,COALESCE(r.stored_filename,d.stored_filename) stored_filename,
            CASE WHEN j.revision_id IS NULL THEN d.page_count ELSE r.page_count END page_count,al.version_code
            FROM image_preparations j JOIN documents d ON d.id=j.document_id
            LEFT JOIN document_revisions r ON r.id=j.revision_id
            LEFT JOIN access_links al ON al.id=j.access_link_id
            WHERE (j.revision_id IS NULL AND d.is_active=1 OR r.status='preparing') AND (j.access_link_id IS NULL OR al.is_active=1)
                AND j.status IN ('queued','working','failed') AND j.attempts<5 AND j.retry_at<=? AND j.lease_until<=?
                AND NOT EXISTS (SELECT 1 FROM image_preparations locked WHERE locked.lease_until>?)
                AND NOT EXISTS (SELECT 1 FROM document_revisions locked WHERE locked.lease_until>?)
            ORDER BY j.priority DESC, CASE WHEN j.completed<MIN(5,j.total) THEN 0 ELSE 1 END,
                j.access_link_id DESC, j.completed, j.updated_at, j.id LIMIT 1`).get(now, now, now, now);
        if (!row) return null;
        const lease = now + 300000;
        db.prepare("UPDATE image_preparations SET status='working',lease_until=?,updated_at=? WHERE id=?").run(lease, now, row.id);
        return { ...row, lease_until: lease };
    })();
}

async function runNext({ renderBase = prepareBaseImage, renderMarked = getMarkedImage, upload = require('./edgeMediaService').uploadImage } = {}) {
    const job = claimJob();
    if (!job) return false;
    try {
        const source = sourceFor(job);
        const info = await getPreviewInfo(source, job.page_count);
        if (info.version !== job.version) {
            if (job.revision_id) await require('./documentRevisionService').scheduleRevision(job.revision_id);
            else await scheduleDocument(job.document_id);
            return true;
        }
        const disk = await fs.promises.statfs(path.dirname(source));
        const requested = Number(process.env.IMAGE_PREPARATION_MIN_FREE_MB || 2048);
        const minimum = (Number.isFinite(requested) && requested >= 256 ? requested : 2048) * 1048576;
        if (disk.bavail * disk.bsize < minimum) throw new Error('DISK_SPACE');
        const index = job.completed;
        const page = index % info.pageCount + 1;
        const profile = index < info.pageCount ? 'view' : 'detail';
        // Pin the shared bases and marked assets before any cache pruning can run.
        await renderBase(source, page, profile, job.version, info.pageCount);
        if (job.access_link_id) {
            // Access preparation also builds the shared bases. Reflect that work
            // in the document progress and avoid scheduling the same base scan again.
            db.prepare(`UPDATE image_preparations SET completed=MAX(completed,?),
                status=CASE WHEN MAX(completed,?)>=total THEN 'ready' ELSE 'queued' END,
                attempts=0,retry_at=0,lease_until=0,error=NULL,updated_at=?
                WHERE document_id=? AND access_link_id IS NULL AND version=? AND revision_id IS ?`)
                .run(index + 1, index + 1, Date.now(), job.document_id, job.version, job.revision_id);
            const image = await renderMarked(source, job.version_code, page, profile, job.version, info.pageCount);
            await upload({ documentId: job.document_id, linkId: job.access_link_id, version: job.version, page, profile, file: image.file });
        }
        // A deleted/replaced job must not be resurrected after slow conversion or upload.
        db.prepare(`UPDATE image_preparations SET completed=completed+1,
            status=CASE WHEN completed+1>=total THEN 'ready' ELSE 'queued' END,
            attempts=0,retry_at=0,lease_until=0,error=NULL,updated_at=?
            WHERE id=? AND version=? AND storage=? AND lease_until=?`)
            .run(Date.now(), job.id, job.version, job.storage, job.lease_until);
    } catch (error) {
        db.prepare(`UPDATE image_preparations SET status='failed',attempts=attempts+1,retry_at=?,lease_until=0,error=?,updated_at=?
            WHERE id=? AND version=? AND lease_until=?`).run(Date.now() + Math.min(900000, 30000 * 2 ** job.attempts),
                String(error.code || error.message).slice(0, 150), Date.now(), job.id, job.version, job.lease_until);
        console.warn('[IMAGES] Preparação interrompida no trabalho', job.id, error.code || error.status || 'error');
    }
    return true;
}

module.exports = { sourceFor, scheduleDocument, reconcile, statusForDocument, readyForLink, repairLink, prioritizeLink, claimJob, runNext };
