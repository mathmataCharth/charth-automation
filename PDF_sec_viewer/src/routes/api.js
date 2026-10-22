'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const security = require('../middleware/security');
const { authorizePdf } = require('../services/viewerAccessService');
const { readManifest } = require('../services/pdfPartsService');
const { getMarkedPdf } = require('../services/watermarkService');
const { getLinkByToken } = require('../services/accessService');
const { unavailable } = require('../services/viewerAccessService');
const { getDocumentById } = require('../services/documentService');
const { getLinkById } = require('../services/accessService');
const { getReadyImage } = require('../services/imagePreviewService');
const { readyForLink } = require('../services/imagePreparationService');
const edgeMedia = require('../services/edgeMediaService');

router.use(security);

function sourceFile(link) {
    return path.resolve(process.env.UPLOAD_DIR || './uploads', link.stored_filename);
}

router.get('/pdf/:token/info', authorizePdf, (req, res) => {
    const link = req.pdfLink;
    const manifest = readManifest(sourceFile(link));
    const prefix = `/api/pdf/${encodeURIComponent(req.params.token)}`;
    res.json({
        pageCount: manifest ? manifest.pageCount : (link.page_count || null),
        title: link.document_title,
        parts: manifest ? manifest.parts.map((part, index) => ({
            start: part.start, end: part.end,
            url: `${prefix}/parts/${manifest.version}/${index}`
        })) : null,
        url: `${prefix}/document`
    });
});

function sendPdf(req, res, filePath) {
    // Express implements standard byte ranges, HEAD, and stream cancellation.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(filePath, { cacheControl: false, lastModified: false }, (error) => {
        if (!error || res.headersSent || res.destroyed) return;
        const status = error.statusCode || error.status || 500;
        if (error.headers) {
            for (const [key, value] of Object.entries(error.headers)) res.setHeader(key, value);
        }
        res.status(status).end();
    });
}

async function sendAccessPdf(req, res, source) {
    try {
        const root = sourceFile(req.pdfLink) + '.parts/access-cache';
        const file = await getMarkedPdf(source, req.pdfLink.version_code, root);
        // Recheck revocation/expiry after asynchronous preparation.
        const error = unavailable(getLinkByToken(req.params.token));
        if (error) return res.status(error.status).json({ error: error.error });
        return sendPdf(req, res, file);
    } catch (error) {
        console.error('[ACCESS PDF]', error.message);
        const missingSource = error.code === 'ENOENT' && error.path === source;
        return res.status(missingSource ? 404 : 503).json({ error: 'Não foi possível preparar o documento. Tente novamente.' });
    }
}

router.get('/pdf/:token/document', authorizePdf, (req, res) => {
    return sendAccessPdf(req, res, sourceFile(req.pdfLink));
});

router.get('/pdf/:token/parts/:version/:index', authorizePdf, (req, res) => {
    const file = sourceFile(req.pdfLink);
    const manifest = readManifest(file, req.params.version);
    const index = Number(req.params.index);
    if (!manifest || !/^\d+$/.test(req.params.index) ||
        !Number.isSafeInteger(index) || index < 0 || index >= manifest.parts.length) {
        return res.status(404).json({ error: 'Bloco não encontrado.' });
    }
    return sendAccessPdf(req, res, path.join(file + '.parts', manifest.version, `${index}.pdf`));
});

router.get('/images/:token/info', authorizePdf, async (req, res) => {
    try {
        const doc = getDocumentById(req.pdfLink.document_id);
        const info = doc && await readyForLink(req.pdfLink, doc);
        if (!info) return res.status(503).json({ error: 'As imagens estão sendo preparadas.' });
        return res.json(info);
    } catch (_) { return res.status(503).json({ error: 'Imagens indisponíveis.' }); }
});

router.get('/images/:token/images/:version/:page/:profile', authorizePdf, async (req, res) => {
    try {
        const link = req.pdfLink, doc = getDocumentById(link.document_id);
        if (!/^[a-f0-9]{64}$/.test(req.params.version) || !/^[1-9]\d{0,5}$/.test(req.params.page)) return res.status(400).end();
        const info = doc && await readyForLink(link, doc);
        if (!info) return res.status(503).json({ error: 'As imagens estão sendo preparadas.' });
        const image = await getReadyImage(sourceFile(link), link.version_code, Number(req.params.page), req.params.profile,
            req.params.version, doc.page_count);
        const error = unavailable(getLinkByToken(req.params.token));
        if (error) return res.status(error.status).json({ error: error.error });
        res.setHeader('Cache-Control', 'private, no-store');
        const job = require('../config/database').prepare('SELECT storage FROM image_preparations WHERE job_key=?').get(`access:${link.id}`);
        const url = job.storage === edgeMedia.storageIdentity() && edgeMedia.edgeUrl({ documentId: doc.id, linkId: link.id,
            version: info.version, page: Number(req.params.page), profile: req.params.profile });
        if (url) return res.redirect(302, url);
        res.setHeader('X-Preview-Cache', 'HIT');
        res.setHeader('Server-Timing', 'prepare;dur=0');
        return res.sendFile(image.file, { cacheControl: false, lastModified: false }, err => {
            if (err && !res.headersSent) res.status(err.status || 503).end();
        });
    } catch (error) {
        if (error.status === 503) require('../services/imagePreparationService').repairLink(req.pdfLink.id);
        return res.status(error.status || 503).json({ error: error.status ? error.message : 'Imagem indisponível.' });
    }
});

// Signed, short-lived grants originate only from authenticated image requests.
router.post('/media/authorize', async (req, res) => {
    try {
        const claim = edgeMedia.verifyTicket(req.body?.ticket);
        if (!claim) return res.status(401).end();
        const link = getLinkById(claim.linkId), doc = link && getDocumentById(link.document_id);
        if (!link || !doc || doc.id !== claim.documentId || unavailable({ ...link, document_is_active: doc.is_active })) return res.status(403).end();
        const info = await readyForLink(link, doc);
        const job = require('../config/database').prepare('SELECT storage FROM image_preparations WHERE job_key=?').get(`access:${link.id}`);
        if (!info || info.version !== claim.version || claim.page > info.pageCount || job.storage !== edgeMedia.storageIdentity()) return res.status(403).end();
        return res.status(204).end();
    } catch (_) { return res.status(503).end(); }
});

module.exports = router;
