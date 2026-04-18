'use strict';

const db = require('../config/database');

function log(accessLinkId, ipAddress, userAgent, action, details) {
    const detailsStr = details && typeof details === 'object'
        ? JSON.stringify(details)
        : (details || null);

    db.prepare(`
        INSERT INTO access_logs (access_link_id, ip_address, user_agent, action, details)
        VALUES (?, ?, ?, ?, ?)
    `).run(accessLinkId, ipAddress || null, userAgent || null, action, detailsStr);
}

function getLogs(filters) {
    filters = filters || {};

    let sql = `
        SELECT
            al_log.id,
            al_log.created_at,
            al_log.ip_address,
            al_log.user_agent,
            al_log.action,
            al_log.details,
            lnk.recipient_name,
            lnk.recipient_email,
            lnk.token,
            lnk.document_id,
            doc.title AS document_title
        FROM access_logs al_log
        JOIN access_links lnk ON lnk.id = al_log.access_link_id
        JOIN documents doc ON doc.id = lnk.document_id
        WHERE 1=1
    `;

    const params = [];

    if (filters.documentId) {
        sql += ' AND lnk.document_id = ?';
        params.push(filters.documentId);
    }

    if (filters.linkId) {
        sql += ' AND al_log.access_link_id = ?';
        params.push(filters.linkId);
    }

    if (filters.action) {
        sql += ' AND al_log.action = ?';
        params.push(filters.action);
    }

    if (filters.dateFrom) {
        sql += ' AND al_log.created_at >= ?';
        params.push(filters.dateFrom);
    }

    if (filters.dateTo) {
        sql += ' AND al_log.created_at <= ?';
        params.push(filters.dateTo + ' 23:59:59');
    }

    sql += ' ORDER BY al_log.created_at DESC LIMIT 500';

    return db.prepare(sql).all(...params);
}

module.exports = { log, getLogs };
