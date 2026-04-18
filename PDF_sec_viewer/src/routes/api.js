'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');

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

    incrementViews(link.id);

    const ip = req.ip;
    const ua = req.get('User-Agent') || '';
    log(link.id, ip, ua, 'view_start', null);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');

    return res.sendFile(filePath, (err) => {
        if (err && !res.headersSent) {
            res.status(500).json({ error: 'Erro ao servir o arquivo.' });
        }
    });
});

module.exports = router;
