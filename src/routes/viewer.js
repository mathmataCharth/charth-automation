'use strict';

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const viewerAuth = require('../middleware/viewerAuth');
const security = require('../middleware/security');
const { getLinkByToken } = require('../services/accessService');
const { comparePassword } = require('../utils/hash');
const { log } = require('../services/logService');

// Rate limiter for password attempts
const maxAttempts = parseInt(process.env.MAX_PASSWORD_ATTEMPTS || '5', 10);
const windowMinutes = parseInt(process.env.PASSWORD_ATTEMPT_WINDOW_MINUTES || '1', 10);

const passwordRateLimit = rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max: maxAttempts,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Muitas tentativas. Aguarde um momento antes de tentar novamente.',
    keyGenerator: (req) => req.ip
});

// Apply security headers to all viewer routes
router.use(security);

// GET /v/:token - Show password form or "continue" link
router.get('/:token', (req, res) => {
    const { token } = req.params;
    const link = getLinkByToken(token);

    if (!link) {
        return res.status(404).render('viewer/password', {
            title: 'Documento',
            token,
            error: null,
            status: 'not_found'
        });
    }

    // Check link active
    if (!link.is_active) {
        return res.render('viewer/password', {
            title: link.document_title,
            token,
            error: null,
            status: 'disabled'
        });
    }

    // Check document active
    if (!link.document_is_active) {
        return res.render('viewer/password', {
            title: link.document_title,
            token,
            error: null,
            status: 'unavailable'
        });
    }

    // Check expiration
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
        return res.render('viewer/password', {
            title: link.document_title,
            token,
            error: null,
            status: 'expired'
        });
    }

    // Check max views
    if (link.max_views && link.views_count >= link.max_views) {
        return res.render('viewer/password', {
            title: link.document_title,
            token,
            error: null,
            status: 'limit_reached'
        });
    }

    // Check if already authenticated — show "continue" option instead of auto-redirect
    const alreadyAuthed = req.session &&
        req.session.viewerTokens &&
        req.session.viewerTokens[token] === true;

    res.render('viewer/password', {
        title: link.document_title,
        token,
        error: null,
        status: 'ok',
        alreadyAuthed: alreadyAuthed || false
    });
});

// POST /v/:token/auth - Validate password
router.post('/:token/auth', passwordRateLimit, async (req, res) => {
    const { token } = req.params;
    const { password } = req.body;

    const ip = req.ip;
    const ua = req.get('User-Agent') || '';

    const link = getLinkByToken(token);

    if (!link) {
        return res.status(404).render('viewer/password', {
            title: 'Documento',
            token,
            error: 'Link inválido.',
            status: 'not_found'
        });
    }

    // Log attempt
    log(link.id, ip, ua, 'password_attempt', null);

    // Validations
    if (!link.is_active) {
        return res.render('viewer/password', {
            title: link.document_title,
            token,
            error: null,
            status: 'disabled'
        });
    }

    if (!link.document_is_active) {
        return res.render('viewer/password', {
            title: link.document_title,
            token,
            error: null,
            status: 'unavailable'
        });
    }

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
        return res.render('viewer/password', {
            title: link.document_title,
            token,
            error: null,
            status: 'expired'
        });
    }

    if (link.max_views && link.views_count >= link.max_views) {
        return res.render('viewer/password', {
            title: link.document_title,
            token,
            error: null,
            status: 'limit_reached'
        });
    }

    // Verify password
    const ok = await comparePassword(password || '', link.password_hash);

    if (!ok) {
        log(link.id, ip, ua, 'password_failure', null);
        return res.render('viewer/password', {
            title: link.document_title,
            token,
            error: 'Senha incorreta. Tente novamente.',
            status: 'ok',
            alreadyAuthed: false
        });
    }

    // Success
    if (!req.session.viewerTokens) {
        req.session.viewerTokens = {};
    }
    req.session.viewerTokens[token] = true;

    log(link.id, ip, ua, 'password_success', null);

    return res.redirect(`/v/${token}/view`);
});

// GET /v/:token/view - Render the viewer
router.get('/:token/view', viewerAuth, (req, res) => {
    const { token } = req.params;
    const link = getLinkByToken(token);

    if (!link) {
        return res.status(404).send('Documento não encontrado.');
    }

    res.render('viewer/view', {
        title: link.document_title,
        token,
        pageCount: link.page_count || 1
    });
});

module.exports = router;
