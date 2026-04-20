'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');

/**
 * Comprime um PDF com Ghostscript (preset /ebook: 150 DPI, JPEG médio).
 * Reduz drasticamente o tamanho de PDFs com imagens não otimizadas.
 * Se o gs não estiver instalado, falhar, ou produzir arquivo MAIOR,
 * retorna silenciosamente mantendo o original.
 *
 * Preset /ebook é um bom balanço qualidade/tamanho para lookbooks.
 * Alternativas: /screen (72 DPI, menor), /printer (300 DPI, maior).
 */
async function compressPdf(filePath) {
    const tmpPath = filePath + '.compressed';
    let originalSize;
    try {
        originalSize = fs.statSync(filePath).size;
    } catch (e) {
        return false;
    }

    try {
        // Configuração agressiva para lookbook DIGITAL (visualização em tela):
        // - 96 DPI para imagens coloridas/grayscale (suficiente para web/4K)
        // - 300 DPI para imagens monocromáticas (mantém nitidez de texto)
        // - JPEG quality 75 (excelente para web, perda visual quase nula)
        // - DownsampleType bicúbico (melhor qualidade que average/subsample)
        // Resultado típico: 70-85% de redução em PDFs com imagens 300 DPI.
        await execFileAsync('gs', [
            '-sDEVICE=pdfwrite',
            '-dCompatibilityLevel=1.5',
            '-dNOPAUSE',
            '-dQUIET',
            '-dBATCH',
            '-dDetectDuplicateImages=true',
            '-dCompressFonts=true',
            '-dSubsetFonts=true',
            // Imagens coloridas
            '-dDownsampleColorImages=true',
            '-dColorImageDownsampleType=/Bicubic',
            '-dColorImageResolution=96',
            '-dColorImageDownsampleThreshold=1.0',
            '-dAutoFilterColorImages=false',
            '-dColorImageFilter=/DCTEncode',
            // Imagens em escala de cinza
            '-dDownsampleGrayImages=true',
            '-dGrayImageDownsampleType=/Bicubic',
            '-dGrayImageResolution=96',
            '-dGrayImageDownsampleThreshold=1.0',
            '-dAutoFilterGrayImages=false',
            '-dGrayImageFilter=/DCTEncode',
            // Imagens monocromáticas (texto/line art) — mantém alta resolução
            '-dDownsampleMonoImages=true',
            '-dMonoImageDownsampleType=/Subsample',
            '-dMonoImageResolution=300',
            '-dMonoImageDownsampleThreshold=1.0',
            // JPEG quality (0.0–1.0, onde 0.75 = qualidade ~75)
            '-c', '<< /ColorACSImageDict << /QFactor 0.40 /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1] >> >> setdistillerparams',
            '-f',
            `-sOutputFile=${tmpPath}`,
            filePath
        ], { timeout: 1800000 }); // 30 min para PDFs muito grandes

        // Verifica se o resultado faz sentido (não-vazio e menor que original)
        if (!fs.existsSync(tmpPath)) return false;
        const newSize = fs.statSync(tmpPath).size;

        if (newSize === 0 || newSize >= originalSize) {
            // Compressão não ajudou — descarta
            try { fs.unlinkSync(tmpPath); } catch (e) {}
            return false;
        }

        fs.renameSync(tmpPath, filePath);
        console.log(`[COMPRESS] ${(originalSize/1024/1024).toFixed(1)} MB → ${(newSize/1024/1024).toFixed(1)} MB (${Math.round((1 - newSize/originalSize) * 100)}% menor)`);
        return true;
    } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
        console.warn('[COMPRESS] Falha ao comprimir PDF:', err.message);
        return false;
    }
}

/**
 * Lineariza um PDF (Fast Web View). Se o qpdf não estiver instalado
 * ou o arquivo não puder ser linearizado, retorna silenciosamente
 * mantendo o arquivo original.
 */
async function linearizePdf(filePath) {
    const tmpPath = filePath + '.linearized';
    try {
        await execFileAsync('qpdf', ['--linearize', filePath, tmpPath], { timeout: 120000 });
        // Substitui o arquivo original pelo linearizado
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (err) {
        // qpdf pode retornar exit code 3 mesmo em sucesso (warnings)
        // Se o arquivo de saída existe, o resultado é válido
        if (fs.existsSync(tmpPath)) {
            try {
                const stat = fs.statSync(tmpPath);
                if (stat.size > 0) {
                    fs.renameSync(tmpPath, filePath);
                    return true;
                }
            } catch (e) {}
            try { fs.unlinkSync(tmpPath); } catch (e) {}
        }
        console.warn('[LINEARIZE] Falha ao linearizar PDF:', err.message);
        return false;
    }
}

const adminAuth = require('../middleware/adminAuth');
const db = require('../config/database');
const { hashPassword, comparePassword } = require('../utils/hash');
const { generateToken } = require('../utils/token');
const { getAllDocuments, getDocumentById, createDocument, toggleDocument, deleteDocument } = require('../services/documentService');
const { getLinksForDocument, createLink, toggleLink, deleteLink } = require('../services/accessService');

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

        // Lineariza síncrono (rápido, ~5-30s mesmo em PDFs grandes)
        // Garante que o PDF já fica utilizável imediatamente para o viewer.
        await linearizePdf(filePath);

        const initialSize = (() => {
            try { return fs.statSync(filePath).size; } catch (e) { return req.file.size; }
        })();

        const docId = createDocument(
            title,
            req.file.originalname,
            req.file.filename,
            initialSize,
            pageCount
        );

        // Responde já — o admin não precisa esperar a compressão.
        res.redirect(`/admin/documents/${docId}`);

        // Compressão pesada (gs) roda em background. Pode levar minutos
        // em PDFs grandes. Quando terminar, re-lineariza (gs descomprime
        // a estrutura) e atualiza file_size no banco.
        setImmediate(async () => {
            try {
                console.log(`[BG] Iniciando compressão de ${req.file.filename}...`);
                const ok = await compressPdf(filePath);
                if (ok) {
                    await linearizePdf(filePath);
                    const newSize = fs.statSync(filePath).size;
                    db.prepare('UPDATE documents SET file_size = ? WHERE id = ?').run(newSize, docId);
                    console.log(`[BG] Compressão concluída: ${req.file.filename} (${(newSize/1024/1024).toFixed(1)} MB)`);
                } else {
                    console.log(`[BG] Compressão sem ganho: ${req.file.filename}`);
                }
            } catch (e) {
                console.error('[BG] Erro na compressão de fundo:', e.message);
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
    res.render('admin/document', { doc, links, baseUrl, adminUsername: req.session.adminUsername });
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

    const maxViewsInt = max_views ? parseInt(max_views, 10) : null;
    const expiresAtStr = expires_at ? expires_at.replace('T', ' ') : null;

    createLink(docId, token, recipient_name.trim(), recipient_email || null, passwordHash, maxViewsInt, expiresAtStr);

    return res.redirect(`/admin/documents/${docId}`);
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

module.exports = router;
