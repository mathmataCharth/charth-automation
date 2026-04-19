'use strict';

/**
 * Re-processa todos os PDFs já existentes em uploads/:
 * comprime com Ghostscript e lineariza com qpdf.
 *
 * Uso:
 *   node scripts/recompress.js
 *
 * O script é idempotente: rodar de novo em PDFs já processados
 * não quebra nada (gs simplesmente gera um arquivo do mesmo tamanho
 * e o compressPdf descarta a compressão se não houver ganho).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const db = require('../src/config/database');

const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');

async function compressPdf(filePath) {
    const tmpPath = filePath + '.compressed';
    const originalSize = fs.statSync(filePath).size;

    try {
        await execFileAsync('gs', [
            '-sDEVICE=pdfwrite',
            '-dCompatibilityLevel=1.5',
            '-dPDFSETTINGS=/ebook',
            '-dNOPAUSE',
            '-dQUIET',
            '-dBATCH',
            '-dDetectDuplicateImages=true',
            '-dCompressFonts=true',
            '-r150',
            `-sOutputFile=${tmpPath}`,
            filePath
        ], { timeout: 600000 });

        if (!fs.existsSync(tmpPath)) return { ok: false, originalSize, newSize: originalSize };
        const newSize = fs.statSync(tmpPath).size;

        if (newSize === 0 || newSize >= originalSize) {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
            return { ok: false, originalSize, newSize: originalSize };
        }

        fs.renameSync(tmpPath, filePath);
        return { ok: true, originalSize, newSize };
    } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
        return { ok: false, originalSize, newSize: originalSize, error: err.message };
    }
}

async function linearizePdf(filePath) {
    const tmpPath = filePath + '.linearized';
    try {
        await execFileAsync('qpdf', ['--linearize', filePath, tmpPath], { timeout: 120000 });
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (err) {
        if (fs.existsSync(tmpPath)) {
            try {
                if (fs.statSync(tmpPath).size > 0) {
                    fs.renameSync(tmpPath, filePath);
                    return true;
                }
            } catch (e) {}
            try { fs.unlinkSync(tmpPath); } catch (e) {}
        }
        return false;
    }
}

(async () => {
    const docs = db.prepare('SELECT id, title, stored_filename, file_size FROM documents').all();

    if (docs.length === 0) {
        console.log('Nenhum documento encontrado.');
        return;
    }

    console.log(`Processando ${docs.length} documento(s)...\n`);

    let totalBefore = 0;
    let totalAfter = 0;

    for (const doc of docs) {
        const filePath = path.resolve(uploadDir, doc.stored_filename);
        if (!fs.existsSync(filePath)) {
            console.log(`[SKIP] ${doc.title} — arquivo não encontrado (${doc.stored_filename})`);
            continue;
        }

        console.log(`[${doc.id}] ${doc.title}`);
        console.log(`       ${doc.stored_filename}`);

        const startSize = fs.statSync(filePath).size;
        totalBefore += startSize;
        console.log(`       Antes: ${(startSize/1024/1024).toFixed(1)} MB`);

        // Comprime
        const compressResult = await compressPdf(filePath);
        if (compressResult.ok) {
            console.log(`       gs:    ${(compressResult.newSize/1024/1024).toFixed(1)} MB (-${Math.round((1 - compressResult.newSize/compressResult.originalSize) * 100)}%)`);
        } else {
            console.log(`       gs:    (sem ganho ou erro)`);
        }

        // Lineariza
        const linearOk = await linearizePdf(filePath);
        console.log(`       qpdf:  ${linearOk ? 'linearizado' : 'falhou'}`);

        // Atualiza tamanho no banco
        const finalSize = fs.statSync(filePath).size;
        totalAfter += finalSize;
        db.prepare('UPDATE documents SET file_size = ? WHERE id = ?').run(finalSize, doc.id);
        console.log(`       Final: ${(finalSize/1024/1024).toFixed(1)} MB\n`);
    }

    console.log('─'.repeat(50));
    console.log(`Total antes: ${(totalBefore/1024/1024).toFixed(1)} MB`);
    console.log(`Total depois: ${(totalAfter/1024/1024).toFixed(1)} MB`);
    if (totalBefore > 0) {
        console.log(`Redução: ${Math.round((1 - totalAfter/totalBefore) * 100)}%`);
    }
})();
