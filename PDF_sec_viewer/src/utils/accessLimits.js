'use strict';

const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function expiryDate(value) {
    // Historical values were stored without a zone on the UTC production server.
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)
        ? value.replace(' ', 'T') + 'Z' : value;
    return new Date(normalized);
}

function expiryInput(value) {
    if (!value) return '';
    const date = expiryDate(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function isExpired(value, now = Date.now()) {
    return Boolean(value) && expiryDate(value).getTime() <= now;
}

function parseAccessLimits(body) {
    if (!body || typeof body.max_views !== 'string' || typeof body.expires_at !== 'string') {
        throw new Error('Informe os limites de acesso.');
    }
    const views = body.max_views.trim();
    const maxViews = views === '' ? null : Number(views);
    if (views !== '' && (!/^\d+$/.test(views) || !Number.isSafeInteger(maxViews) || maxViews < 1)) {
        throw new Error('O limite de visualizações deve ser um número inteiro maior que zero.');
    }
    const local = body.expires_at.trim();
    if (local === '') return { maxViews, expiresAt: null };
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) {
        throw new Error('Informe uma data e hora de expiração válidas.');
    }
    const wall = Date.parse(local + ':00Z');
    if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== local) {
        throw new Error('Informe uma data e hora de expiração válidas.');
    }
    // Resolve the entered wall clock in Sao Paulo, independent of the server TZ.
    let instant = wall;
    for (let attempt = 0; attempt < 3; attempt++) {
        const formatted = expiryInput(new Date(instant).toISOString());
        if (formatted === local) return { maxViews, expiresAt: new Date(instant).toISOString() };
        instant -= Date.parse(formatted + ':00Z') - wall;
    }
    throw new Error('Esta data e hora não existem no horário de Brasília.');
}

module.exports = { parseAccessLimits, expiryInput, isExpired };
