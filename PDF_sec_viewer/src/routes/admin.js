'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const { prepareParts } = require('../services/pdfPartsService');

const adminAuth = require('../middleware/adminAuth');
const db = require('../config/database');
const { hashPassword, comparePassword } = require('../utils/hash');
const { generateToken } = require('../utils/token');
const { getAllDocuments, getDocumentById, createDocument, toggleDocument, deleteDocument } = require('../services/documentService');
const { getLinksForDocument, createLink, toggleLink, deleteLink, getLinkById, updateLinkLimits } = require('../services/accessService');
const { parseAccessLimits, expiryInput } = require('../utils/accessLimits');

router.use((req, res, next) => {
    res.locals.expiryInput = expiryInput;
    next();
});

// Multer storage configuration
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, uuidv4() + '.pdf');
    }
});

const maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);

const upload = multer({
    storage,
    limits: { fileSize: maxFileSizeMB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'application/pdf') {
            return cb(new Error('Apenas PDFs são permitidos'));
        }
        cb(null, true);
    }
});

// GET /admin/login
router.get('/login', (req, res) => {
    if (req.session && req.session.adminId) {
        return res.redirect('/admin/dashboard');
    }
    res.render('admin/login', { error: null });
});

// POST /admin/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.render('admin/login', { error: 'Preencha todos os campos.' });
    }

    const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);

    if (!user) {
        return res.render('admin/login', { error: 'Usuário ou senha inválidos.' });
    }

    const ok = await comparePassword(password, user.password_hash);
    if (!ok) {
        return res.render('admin/login', { error: 'Usuário ou senha inválidos.' });
    }

    req.session.adminId = user.id;
    req.session.adminUsername = user.username;
    return res.redirect('/admin/dashboard');
});

// POST /admin/logout
router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/admin/login');
    });
});

// GET /admin/dashboard
router.get('/dashboard', adminAuth, (req, res) => {
    const documents = getAllDocuments();
    res.render('admin/dashboard', { documents, adminUsername: req.session.adminUsername });
});

// POST /admin/documents/upload
router.post('/documents/upload', adminAuth, (req, res) => {
    upload.single('pdf')(req, res, async (err) => {
        if (err) {
            const documents = getAllDocuments();
            return res.render('admin/dashboard', {
                documents,
                adminUsername: req.session.adminUsername,
                uploadError: err.message
            });
        }

        if (!req.file) {
            const documents = getAllDocuments();
            return res.render('admin/dashboard', {
                documents,
                adminUsername: req.session.adminUsername,
                uploadError: 'Nenhum arquivo enviado.'
            });
        }

        const title = (req.body.title || '').trim();
        if (!title) {
            fs.unlink(req.file.path, () => {});
            const documents = getAllDocuments();
            return res.render('admin/dashboard', {
                documents,
                adminUsername: req.session.adminUsername,
                uploadError: 'O título é obrigatório.'
            });
        }

        // Verify magic bytes
        const filePath = req.file.path;
        let fileBuffer;
        try {
            fileBuffer = fs.readFileSync(filePath);
        } catch (e) {
            const documents = getAllDocuments();
            return res.render('admin/dashboard', {
                documents,
                adminUsername: req.session.adminUsername,
                uploadError: 'Erro ao ler o arquivo enviado.'
            });
        }

        const magic = fileBuffer.slice(0, 4).toString('ascii');
        if (magic !== '%PDF') {
            fs.unlink(filePath, () => {});
            const documents = getAllDocuments();
            return res.render('admin/dashboard', {
                documents,
                adminUsername: req.session.adminUsername,
                uploadError: 'O arquivo não é um PDF válido.'
            });
        }

        let pageCount = null;
        try {
            const data = await pdfParse(fileBuffer);
            pageCount = data.numpages || null;
        } catch (e) {
            // Non-fatal: page count unknown
        }

        const docId = createDocument(
            title,
            req.file.originalname,
            req.file.filename,
            req.file.size,
            pageCount
        );

        // Preserve the uploaded bytes. Only derived blocks are prepared.
        res.redirect(`/admin/documents/${docId}`);
        setImmediate(async () => {
            try {
                await prepareParts(filePath);
                console.log(`[BG] Blocos preparados: ${req.file.filename}`);
            } catch (e) {
                console.error('[BG] Falha ao preparar blocos; original preservado:', e.message);
            }
        });
        return;
    });
});

// GET /admin/documents/:id
router.get('/documents/:id', adminAuth, (req, res) => {
    const doc = getDocumentById(req.params.id);
    if (!doc) {
        return res.status(404).send('Documento não encontrado.');
    }
    const links = getLinksForDocument(doc.id);
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const linkUpdated = links.some(link => String(link.id) === req.query.updated);
    res.render('admin/document', { doc, links, baseUrl, linkUpdated, adminUsername: req.session.adminUsername });
});

// POST /admin/documents/:id/toggle
router.post('/documents/:id/toggle', adminAuth, (req, res) => {
    toggleDocument(req.params.id);
    res.redirect(`/admin/documents/${req.params.id}`);
});

// POST /admin/documents/:id/delete
router.post('/documents/:id/delete', adminAuth, (req, res) => {
    deleteDocument(req.params.id);
    res.redirect('/admin/dashboard');
});

// POST /admin/documents/:id/links
router.post('/documents/:id/links', adminAuth, async (req, res) => {
    const docId = req.params.id;
    const doc = getDocumentById(docId);
    if (!doc) {
        return res.status(404).send('Documento não encontrado.');
    }

    const { recipient_name, recipient_email, password, max_views, expires_at } = req.body;

    if (!recipient_name || !recipient_name.trim()) {
        const links = getLinksForDocument(docId);
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        return res.render('admin/document', {
            doc,
            links,
            baseUrl,
            adminUsername: req.session.adminUsername,
            linkError: 'O nome do destinatário é obrigatório.'
        });
    }

    if (!password || password.length < 4) {
        const links = getLinksForDocument(docId);
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        return res.render('admin/document', {
            doc,
            links,
            baseUrl,
            adminUsername: req.session.adminUsername,
            linkError: 'A senha deve ter pelo menos 4 caracteres.'
        });
    }

    const token = generateToken();
    const passwordHash = await hashPassword(password);

    let limits;
    try {
        limits = parseAccessLimits({ max_views, expires_at });
    } catch (error) {
        return res.status(400).render('admin/document', {
            doc, links: getLinksForDocument(docId),
            baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
            adminUsername: req.session.adminUsername, linkError: error.message
        });
    }

    createLink(docId, token, recipient_name.trim(), recipient_email || null, passwordHash, limits.maxViews, limits.expiresAt);

    return res.redirect(`/admin/documents/${docId}`);
});

// POST /admin/links/:id/limits
router.post('/links/:id/limits', adminAuth, (req, res) => {
    const link = getLinkById(req.params.id);
    if (!link) return res.status(404).send('Acesso não encontrado.');
    const values = req.body || {};
    let limits;
    try {
        limits = parseAccessLimits(values);
    } catch (error) {
        const doc = getDocumentById(link.document_id);
        if (!doc) return res.status(404).send('Documento não encontrado.');
        return res.status(400).render('admin/document', {
            doc, links: getLinksForDocument(doc.id),
            baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
            adminUsername: req.session.adminUsername,
            editError: { id: link.id, message: error.message },
            editValues: {
                max_views: typeof values.max_views === 'string' ? values.max_views : '',
                expires_at: typeof values.expires_at === 'string' ? values.expires_at : ''
            }
        });
    }
    if (!updateLinkLimits(link.id, limits.maxViews, limits.expiresAt)) {
        return res.status(404).send('Acesso não encontrado.');
    }
    return res.redirect(`/admin/documents/${link.document_id}?updated=${link.id}#access-links`);
});

// POST /admin/links/:id/toggle
router.post('/links/:id/toggle', adminAuth, (req, res) => {
    toggleLink(req.params.id);
    const ref = req.get('Referer') || '/admin/dashboard';
    res.redirect(ref);
});

// POST /admin/links/:id/delete
router.post('/links/:id/delete', adminAuth, (req, res) => {
    deleteLink(req.params.id);
    const ref = req.get('Referer') || '/admin/dashboard';
    res.redirect(ref);
});

// GET /admin/logs
router.get('/logs', adminAuth, (req, res) => {
    const { getLogs } = require('../services/logService');
    const logs = getLogs(req.query);
    const documents = getAllDocuments();
    res.render('admin/logs', {
        logs,
        documents,
        filters: req.query,
        adminUsername: req.session.adminUsername
    });
});

router.use('/links/:id/preview', require('./preview'));

module.exports = router;
