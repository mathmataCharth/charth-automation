'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { getLinkByToken, incrementViews } = require('../services/accessService');
const { log } = require('../services/logService');
const security = require('../middleware/security');

router.use(security);

// GET /api/pdf/:token/info
router.get('/pdf/:token/info', (req, res) => {
    const { token } = req.params;

    if (!req.session || !req.session.viewerTokens || !req.session.viewerTokens[token]) {
        return res.status(401).json({ error: 'Não autorizado.' });
    }

    const link = getLinkByToken(token);
    if (!link) {
        return res.status(404).json({ error: 'Link não encontrado.' });
    }

    return res.json({
        pageCount: link.page_count || 1,
        title: link.document_title
    });
});

// GET /api/pdf/:token/document
router.get('/pdf/:token/document', (req, res) => {
    const { token } = req.params;

    if (!req.session || !req.session.viewerTokens || !req.session.viewerTokens[token]) {
        return res.status(401).json({ error: 'Não autorizado.' });
    }

    const link = getLinkByToken(token);

    if (!link) {
        return res.status(404).json({ error: 'Link não encontrado.' });
    }

    if (!link.is_active) {
        return res.status(403).json({ error: 'Link desativado.' });
    }

    if (!link.document_is_active) {
        return res.status(403).json({ error: 'Documento indisponível.' });
    }

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
        return res.status(403).json({ error: 'Link expirado.' });
    }

    if (link.max_views && link.views_count >= link.max_views) {
        return res.status(403).json({ error: 'Limite de visualizações atingido.' });
    }

    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const filePath = path.resolve(uploadDir, link.stored_filename);

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        return res.status(404).json({ error: 'Arquivo não encontrado.' });
    }

    const fileSize = stat.size;
    const range = req.headers.range;

    // Só conta view e loga na requisição inicial (sem Range ou Range começando em 0)
    const isInitialRequest = !range || /^bytes=0-/.test(range);
    if (isInitialRequest) {
        incrementViews(link.id);
        const ip = req.ip;
        const ua = req.get('User-Agent') || '';
        log(link.id, ip, ua, 'view_start', null);
    }

    // Headers comuns
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
        // Parse "bytes=start-end"
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.status(416).end();
        }
        let start = match[1] === '' ? 0 : parseInt(match[1], 10);
        let end = match[2] === '' ? fileSize - 1 : parseInt(match[2], 10);

        if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.status(416).end();
        }

        const chunkSize = end - start + 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunkSize);

        const stream = fs.createReadStream(filePath, { start, end });
        stream.on('error', () => {
            if (!res.headersSent) res.status(500).end();
            else res.destroy();
        });
        return stream.pipe(res);
    }

    // Sem Range: envia arquivo inteiro
    res.setHeader('Content-Length', fileSize);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
    });
    return stream.pipe(res);
});

module.exports = router;
