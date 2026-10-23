'use strict';

const express = require('express');
const path = require('path');
const router = express.Router({ mergeParams: true });
const security = require('../middleware/security');
const { getLinkById } = require('../services/accessService');
const { getDocumentById } = require('../services/documentService');
const { readManifest } = require('../services/pdfPartsService');
const { getMarkedPdf } = require('../services/watermarkService');
const { getPreviewInfo, getReadyImage } = require('../services/imagePreviewService');
const { documentVersion } = require('../utils/documentVersion');

router.use(security);
router.use((req, res, next) => {
    if (req.session?.adminId) return next();
    if (req.path === '/') return res.redirect('/admin/login');
    return res.status(401).json({ error: 'Entre no painel para continuar o teste.' });
});

function context(id, revisionId) {
    if (!/^[1-9]\d*$/.test(String(id))) return null;
    const link = getLinkById(id);
    let doc = link && getDocumentById(link.document_id);
    if (!link || !doc) return null;
    let prefix = `/admin/links/${link.id}/preview`;
    if (revisionId !== undefined) {
        if (!/^[1-9]\d*$/.test(String(revisionId))) return null;
        const revision = require('../services/documentRevisionService').getRevision(revisionId, doc.id);
        if (!revision || !['active','archived','preparing'].includes(revision.status)) return null;
        doc = { ...doc, stored_filename: revision.stored_filename, original_filename: revision.original_filename, page_count: revision.page_count };
        prefix += `/revisions/${revision.id}`;
    }
    const upload = path.resolve(process.env.UPLOAD_DIR || './uploads');
    const source = path.resolve(upload, doc.stored_filename);
    if (!source.startsWith(upload + path.sep)) return null;
    return { link, doc, source, prefix };
}

router.use((req, res, next) => {
    req.preview = context(req.params.id, req.params.revisionId);
    if (!req.preview) return res.status(404).send('Acesso não encontrado.');
    next();
});

router.get('/', (req, res) => {
    const { link, doc, prefix } = req.preview;
    const page = /^[1-9]\d*$/.test(String(req.query.page)) ? Number(req.query.page) : 1;
    res.render('viewer/preview', { link, doc, prefix, mode: req.query.mode === 'pdf' ? 'pdf' : 'images',
        initialPage: Number.isSafeInteger(page) && page <= (doc.page_count || 1) ? page : 1 });
});

router.get('/info', async (req, res) => {
    try {
        const info = await getPreviewInfo(req.preview.source, req.preview.doc.page_count);
        res.json({ ...info, prefix: req.preview.prefix });
    } catch (error) { res.status(error.code === 'ENOENT' ? 404 : 503).json({ error: 'Não foi possível preparar o teste.' }); }
});

function stillAvailable(req) {
    const current = context(req.params.id, req.params.revisionId);
    return current && current.source === req.preview.source && current.link.version_code === req.preview.link.version_code;
}

function sendFile(req, res, file) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(file, { cacheControl: false, lastModified: false }, error => {
        if (error && !res.headersSent && !res.destroyed) res.status(error.status || 500).end();
    });
}

router.get('/images/:version/:page/:profile', async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.version) || !/^[1-9]\d{0,5}$/.test(req.params.page)) {
        return res.status(400).json({ error: 'Página inválida.' });
    }
    try {
        const { source, link, doc } = req.preview;
        const image = await getReadyImage(source, link.version_code, Number(req.params.page),
            req.params.profile, req.params.version, doc.page_count);
        if (!stillAvailable(req)) return res.status(404).json({ error: 'Acesso removido durante o teste.' });
        res.setHeader('X-Preview-Cache', image.cacheHit ? 'HIT' : 'MISS');
        res.setHeader('Server-Timing', `prepare;dur=${image.preparationMs}`);
        return sendFile(req, res, image.file);
    } catch (error) {
        console.error('[IMAGE PREVIEW]', error.message);
        const missingSource = error.code === 'ENOENT' && error.path === req.preview.source;
        return res.status(error.status || (missingSource ? 404 : 503))
            .json({ error: error.status ? error.message : 'Não foi possível preparar a imagem. Tente novamente.' });
    }
});

router.get('/pdf/info', async (req, res) => {
    try {
        const { source, prefix, doc } = req.preview;
        const manifest = readManifest(source);
        const info = await getPreviewInfo(source, doc.page_count);
        const revision = documentVersion(doc);
        res.json({ pageCount: info.pageCount, version: revision, url: prefix + '/pdf/document?revision=' + revision,
            parts: manifest ? manifest.parts.map((part, index) => ({ ...part,
                url: `${prefix}/pdf/parts/${manifest.version}/${index}?revision=${revision}` })) : null });
    } catch (_) { res.status(503).json({ error: 'Não foi possível carregar o PDF.' }); }
});

async function sendPreviewPdf(req, res, source) {
    if (req.query.revision && req.query.revision !== documentVersion(req.preview.doc)) return res.status(409).json({ error: 'Documento atualizado. Recarregue a versão.' });
    try {
        const file = await getMarkedPdf(source, req.preview.link.version_code, req.preview.source + '.parts/access-cache');
        if (!stillAvailable(req)) return res.status(409).json({ error: 'Documento atualizado. Recarregue a versão.' });
        return sendFile(req, res, file);
    } catch (error) {
        console.error('[PDF PREVIEW]', error.message);
        return res.status(503).json({ error: 'Não foi possível preparar o PDF.' });
    }
}

router.get('/pdf/document', (req, res) => sendPreviewPdf(req, res, req.preview.source));
router.get('/pdf/parts/:version/:index', (req, res) => {
    const manifest = readManifest(req.preview.source, req.params.version);
    const index = Number(req.params.index);
    if (!manifest || !/^\d+$/.test(req.params.index) || !Number.isSafeInteger(index) || index >= manifest.parts.length) {
        return res.status(404).json({ error: 'Bloco não encontrado.' });
    }
    return sendPreviewPdf(req, res, path.join(req.preview.source + '.parts', manifest.version, `${index}.pdf`));
});

module.exports = router;
