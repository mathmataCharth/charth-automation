'use strict';

const { getLinkByToken, reserveView } = require('./accessService');
const { log } = require('./logService');

function unavailable(link) {
    if (!link) return { status: 404, error: 'Link não encontrado.' };
    if (!link.is_active) return { status: 403, error: 'Link desativado.' };
    if (!link.document_is_active) return { status: 403, error: 'Documento indisponível.' };
    if (link.expires_at && new Date(link.expires_at) <= new Date()) {
        return { status: 403, error: 'Link expirado.' };
    }
    return null;
}

// One view is one opening of the viewer, regardless of how many chunks it fetches.
function openView(req, link) {
    const error = unavailable(link);
    if (error) return error;
    if (!reserveView(link.id)) return { status: 403, error: 'Limite de visualizações atingido.' };
    if (!req.session.viewerOpenings) req.session.viewerOpenings = {};
    req.session.viewerOpenings[link.token] = true;
    log(link.id, req.ip, req.get('User-Agent') || '', 'view_start', null);
    return null;
}

function authorizePdf(req, res, next) {
    const { token } = req.params;
    if (!req.session || !req.session.viewerTokens || req.session.viewerTokens[token] !== true) {
        return res.status(401).json({ error: 'Não autorizado.' });
    }
    const link = getLinkByToken(token);
    let error = unavailable(link);
    // Compatibility for an already-open viewer from the previous release.
    if (!error && (!req.session.viewerOpenings || !req.session.viewerOpenings[token])) {
        error = openView(req, link);
    }
    if (error) return res.status(error.status).json({ error: error.error });
    req.pdfLink = link;
    next();
}

module.exports = { unavailable, openView, authorizePdf };
