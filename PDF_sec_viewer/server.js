'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const app = express();

// ─── Ensure required directories exist ───────────────────────────────────────
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
const dataDir = path.resolve('./data');

[uploadDir, dataDir].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ─── Initialize DB (creates tables if not exists) ────────────────────────────
const db = require('./src/config/database');

// ─── Helmet (security headers — relaxed for EJS + CDN) ───────────────────────
app.use(
    helmet({
        contentSecurityPolicy: false, // managed per-route by security.js middleware
        crossOriginEmbedderPolicy: false
    })
);

// ─── View engine ─────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Body parsers ────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── Static files ────────────────────────────────────────────────────────────
app.use('/public', express.static(path.join(__dirname, 'public')));

// ─── Session ─────────────────────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';
const viewerMaxAge = parseInt(process.env.VIEWER_SESSION_MAX_AGE_HOURS || '2', 10);

app.use(
    session({
        secret: process.env.SESSION_SECRET || 'fallback-dev-secret-change-me',
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: isProduction,
            sameSite: 'strict',
            maxAge: viewerMaxAge * 60 * 60 * 1000
        }
    })
);

// ─── Trust proxy (for correct IP behind reverse proxy) ───────────────────────
if (isProduction) {
    app.set('trust proxy', 1);
}

// ─── Routes ──────────────────────────────────────────────────────────────────
const adminRoutes  = require('./src/routes/admin');
const viewerRoutes = require('./src/routes/viewer');
const apiRoutes    = require('./src/routes/api');

app.use('/admin',  adminRoutes);
app.use('/v',      viewerRoutes);
app.use('/api',    apiRoutes);

// ─── Root redirect ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/admin/dashboard'));

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).send('Página não encontrada.');
});

// ─── Error handler ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.message || err);
    res.status(500).send('Erro interno do servidor.');
});

// ─── Seed admin user ─────────────────────────────────────────────────────────
async function seedAdmin() {
    const { hashPassword } = require('./src/utils/hash');

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM admin_users').get();
    if (count.cnt === 0) {
        const username = process.env.ADMIN_USERNAME || 'admin';
        const password = process.env.ADMIN_PASSWORD || 'admin123';
        const hash = await hashPassword(password);
        db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run(username, hash);
        console.log(`[SEED] Admin criado: ${username}`);
    }
}

// ─── Start server ────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

seedAdmin().then(() => {
    app.listen(PORT, () => {
        console.log(`[SERVER] DocSecureView rodando em http://localhost:${PORT}`);
        console.log(`[SERVER] Ambiente: ${process.env.NODE_ENV || 'development'}`);
    });
}).catch((err) => {
    console.error('[FATAL] Falha ao iniciar servidor:', err);
    process.exit(1);
});
