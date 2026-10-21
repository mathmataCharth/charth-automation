'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const security = require('../middleware/security');
const { authorizePdf } = require('../services/viewerAccessService');
const { readManifest } = require('../services/pdfPartsService');

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

router.get('/pdf/:token/document', authorizePdf, (req, res) => {
    sendPdf(req, res, sourceFile(req.pdfLink));
});

router.get('/pdf/:token/parts/:version/:index', authorizePdf, (req, res) => {
    const file = sourceFile(req.pdfLink);
    const manifest = readManifest(file, req.params.version);
    const index = Number(req.params.index);
    if (!manifest || !/^\d+$/.test(req.params.index) ||
        !Number.isSafeInteger(index) || index < 0 || index >= manifest.parts.length) {
        return res.status(404).json({ error: 'Bloco não encontrado.' });
    }
    sendPdf(req, res, path.join(file + '.parts', manifest.version, `${index}.pdf`));
});

module.exports = router;
