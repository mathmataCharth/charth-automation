'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { formatVersionLabel } = require('../utils/accessCode');
const { versionLayout } = require('../utils/versionLayout');
const { readManifest } = require('./pdfPartsService');
const run = promisify(execFile);
const STYLE = 'lossless-image-preview-pngbase-v2';
const PROFILES = Object.freeze({ view: 1800, detail: 4800 });
const pending = new Map();
let queue = Promise.resolve();
let metrics;

// Conversion has its own bounded queue; it never joins the live PDF queue.
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 16 });

function digest(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function inputError(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

async function getPreviewInfo(source, pageCount) {
    const stat = await fs.promises.stat(source);
    const version = digest({ source: path.resolve(source), size: stat.size, mtime: stat.mtimeMs, style: STYLE, profiles: PROFILES });
    const prepared = readManifest(source);
    let count = prepared?.pageCount || pageCount;
    if (!Number.isSafeInteger(count) || count < 1) {
        const { stdout } = await run(process.env.QPDF_BIN || 'qpdf', ['--show-npages', source], { timeout: 30000 });
        count = Number(stdout.trim());
    }
    if (!Number.isSafeInteger(count) || count < 1) throw inputError('Não foi possível contar as páginas.', 503);
    return { version, pageCount: count, profiles: PROFILES };
}

function enqueue(key, callback) {
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 12) return Promise.reject(inputError('Preparação ocupada. Tente novamente.', 503));
    const work = queue.then(callback);
    queue = work.catch(() => {});
    pending.set(key, work);
    work.finally(() => pending.delete(key)).catch(() => {});
    return work;
}

async function isFile(file) {
    const stat = await fs.promises.stat(file).catch(() => null);
    return stat && stat.isFile() && stat.size > 0;
}

async function prune(root, keep) {
    // Prepared documents are durable assets, not an evictable request cache.
    if (await isFile(path.join(root, '.prepared'))) return;
    const configured = Number(process.env.IMAGE_PREVIEW_CACHE_MB);
    const max = (Number.isFinite(configured) && configured > 0 ? configured : 1024) * 1024 * 1024;
    const entries = [];
    let total = 0;
    for (const name of await fs.promises.readdir(root)) {
        if (!/^[a-f0-9]{64}\.(webp|png)$/.test(name)) continue;
        const file = path.join(root, name);
        const stat = await fs.promises.stat(file).catch(() => null);
        if (!stat) continue;
        total += stat.size;
        if (!keep.has(file)) entries.push({ file, time: stat.mtimeMs, size: stat.size });
    }
    entries.sort((a, b) => a.time - b.time);
    for (const entry of entries) {
        if (total <= max) break;
        await fs.promises.unlink(entry.file).catch(() => {});
        await fs.promises.unlink(entry.file + '.json').catch(() => {});
        total -= entry.size;
    }
}

async function readBase(file) {
    if (!await isFile(file)) return null;
    try {
        const metadata = JSON.parse(await fs.promises.readFile(file + '.json', 'utf8'));
        if (metadata.width > 0 && metadata.height > 0 && metadata.pageWidth > 0 && metadata.pageHeight > 0) return metadata;
    } catch (_) {}
    return null;
}

async function renderBase(source, page, profile, file, temporary) {
    const onePage = path.join(temporary, 'page.pdf');
    try {
        await run(process.env.QPDF_BIN || 'qpdf', ['--empty', '--stream-data=preserve', '--pages', source, String(page), '--', onePage],
            { timeout: 120000 });
    } catch (error) { if (error.code !== 3) throw error; }
    const pdf = await PDFDocument.load(await fs.promises.readFile(onePage), { updateMetadata: false });
    const p = pdf.getPages()[0];
    const crop = p.getCropBox();
    const rotated = Math.abs(p.getRotation().angle % 180) === 90;
    const prefix = path.join(temporary, 'rendered');
    await run(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-cropbox',
        '-scale-to', String(PROFILES[profile]), '-png', onePage, prefix], { timeout: 120000, maxBuffer: 1024 * 1024 });
    // Reuse the renderer's lossless PNG directly. Encoding a shared WebP here
    // would repeat the expensive encode when adding the access-specific text.
    const output = prefix + '.png';
    const image = await sharp(output).metadata();
    const metadata = { width: image.width, height: image.height,
        pageWidth: rotated ? crop.height : crop.width, pageHeight: rotated ? crop.width : crop.height };
    await fs.promises.writeFile(file + '.json', JSON.stringify(metadata), { mode: 0o600 });
    await fs.promises.rename(output, file);
    return metadata;
}

async function versionSvg(metadata, code) {
    if (!metrics) metrics = PDFDocument.create().then(pdf => pdf.embedFont(StandardFonts.Helvetica));
    const layout = versionLayout(metadata.pageWidth, metadata.pageHeight, code, await metrics);
    const sx = metadata.width / metadata.pageWidth;
    const sy = metadata.height / metadata.pageHeight;
    const text = layout.positions.map(position => `<text x="${position.x}" y="${metadata.pageHeight - position.y}"` +
        ` transform="rotate(${-position.angle} ${position.x} ${metadata.pageHeight - position.y})">${layout.label}</text>`).join('');
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${metadata.width}" height="${metadata.height}">` +
        `<g transform="scale(${sx} ${sy})" fill="#777777" font-family="Arial, Helvetica, sans-serif" font-size="${layout.size}">${text}</g></svg>`);
}

function imagePaths(source, info, code, page, profile) {
    if (!Number.isSafeInteger(page) || page < 1 || !Object.hasOwn(PROFILES, profile)) throw inputError('Página ou resolução inválida.');
    if (page > info.pageCount) throw inputError('Página não encontrada.', 404);
    const root = source + '.parts/image-preview';
    const baseKey = digest({ version: info.version, page, profile });
    return { root, base: path.join(root, baseKey + '.png'),
        file: code ? path.join(root, digest({ baseKey, code, style: STYLE }) + '.webp') : null };
}

async function getReadyImage(source, code, page, profile, expectedVersion, pageCount) {
    formatVersionLabel(code);
    const info = await getPreviewInfo(source, pageCount);
    if (expectedVersion !== info.version) throw inputError('Documento atualizado. Reabra o lookbook.', 409);
    const { file } = imagePaths(source, info, code, page, profile);
    if (!await isFile(file)) throw inputError('Esta imagem ainda está sendo preparada.', 503);
    return { file, cacheHit: true, preparationMs: 0 };
}

async function prepareBaseImage(source, page, profile, expectedVersion, pageCount) {
    const info = await getPreviewInfo(source, pageCount);
    if (expectedVersion !== info.version) throw inputError('Documento atualizado.', 409);
    const { root, base } = imagePaths(source, info, null, page, profile);
    return enqueue(base, async () => {
        await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(path.join(root, '.prepared'), 'durable\n', { mode: 0o600 });
        if (await readBase(base)) return { file: base };
        const temporary = await fs.promises.mkdtemp(path.join(root, 'working-'));
        try {
            await renderBase(source, page, profile, base, temporary);
            if ((await getPreviewInfo(source, pageCount)).version !== info.version) throw inputError('Documento atualizado.', 409);
            return { file: base };
        } finally {
            if (path.resolve(temporary).startsWith(path.resolve(root) + path.sep)) await fs.promises.rm(temporary, { recursive: true, force: true });
        }
    });
}

async function getMarkedImage(source, code, page, profile, expectedVersion, pageCount) {
    formatVersionLabel(code);
    if (!Number.isSafeInteger(page) || page < 1 || !Object.hasOwn(PROFILES, profile)) throw inputError('Página ou resolução inválida.');
    const info = await getPreviewInfo(source, pageCount);
    if (expectedVersion && expectedVersion !== info.version) throw inputError('Documento atualizado. Reabra o teste.', 409);
    if (page > info.pageCount) throw inputError('Página não encontrada.', 404);
    const root = source + '.parts/image-preview';
    const baseKey = digest({ version: info.version, page, profile });
    const base = path.join(root, baseKey + '.png');
    const file = path.join(root, digest({ baseKey, code, style: STYLE }) + '.webp');
    if (await isFile(file)) {
        await fs.promises.utimes(file, new Date(), new Date()).catch(() => {});
        return { file, cacheHit: true, preparationMs: 0 };
    }
    return enqueue(file, async () => {
        const started = Date.now();
        if (await isFile(file)) return { file, cacheHit: true, preparationMs: 0 };
        await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
        const temporary = await fs.promises.mkdtemp(path.join(root, 'working-'));
        try {
            let metadata = await readBase(base);
            if (!metadata) metadata = await renderBase(source, page, profile, base, temporary);
            const svg = await versionSvg(metadata, code);
            const output = path.join(temporary, 'access.webp');
            await sharp(base).composite([{ input: svg }]).webp({ lossless: true, effort: 1 }).toFile(output);
            const after = await getPreviewInfo(source, pageCount);
            if (after.version !== info.version) throw inputError('Documento atualizado durante a preparação.', 409);
            await fs.promises.rename(output, file);
            await fs.promises.utimes(base, new Date(), new Date()).catch(() => {});
            await prune(root, new Set([base, file])).catch(error => console.warn('[IMAGE CACHE]', error.message));
            return { file, base, cacheHit: false, preparationMs: Date.now() - started, ...metadata };
        } finally {
            // Verify the absolute destination before a recursive cleanup on Windows.
            if (path.resolve(temporary).startsWith(path.resolve(root) + path.sep)) {
                await fs.promises.rm(temporary, { recursive: true, force: true });
            }
        }
    });
}

module.exports = { getPreviewInfo, getMarkedImage, getReadyImage, prepareBaseImage, PROFILES };
