'use strict';

function security(req, res, next) {
    let edge = '';
    try { edge = require('../services/edgeMediaService').configuration()?.origin || ''; } catch (_) {}
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://charth.vtexassets.com https://charth.vteximg.com.br; worker-src blob:; child-src blob:; object-src 'none'; frame-ancestors 'none'; connect-src 'self' " + edge
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
}

module.exports = security;
