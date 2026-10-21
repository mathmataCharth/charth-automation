'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PDFDocument, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState,
    concatTransformationMatrix, setTextRenderingMode, TextRenderingMode } = require('pdf-lib');
const { formatVersionLabel } = require('../utils/accessCode');
const run = promisify(execFile);
const pending = new Map();
let queue = Promise.resolve();
const STYLE = 'editorial-three-positions-777777-v4';

async function stampPdf(input, code) {
    const label = formatVersionLabel(code);
    const pdf = await PDFDocument.load(input, { updateMetadata: false });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const page of pdf.getPages()) {
        const { x, y, width, height } = page.getCropBox();
        const rotation = ((page.getRotation().angle % 360) + 360) % 360;
        if (width <= 0 || height <= 0 || ![0, 90, 180, 270].includes(rotation)) {
            throw new Error('Geometria de página inválida.');
        }
        const transforms = {
            0: [1, 0, 0, 1, x, y], 90: [0, 1, -1, 0, x + width, y],
            180: [-1, 0, 0, -1, x + width, y + height], 270: [0, -1, 1, 0, x, y + height]
        };
        const visibleWidth = rotation % 180 ? height : width;
        const visibleHeight = rotation % 180 ? width : height;
        const margin = Math.min(14, visibleWidth * 0.035, visibleHeight * 0.035);
        const size = Math.min(8, visibleHeight / 30,
            (visibleWidth - 2 * margin) / font.widthOfTextAtSize(label, 1));
        const textWidth = font.widthOfTextAtSize(label, size);
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...transforms[rotation]),
            setTextRenderingMode(TextRenderingMode.Fill));
        const positions = [
            { x: (visibleWidth - textWidth) / 2, y: visibleHeight - Math.min(10, visibleHeight * 0.025), angle: 0 },
            { x: visibleWidth * 0.055, y: (visibleHeight - textWidth) / 2, angle: 90 },
            { x: visibleWidth - margin - textWidth, y: visibleHeight * 0.125, angle: 0 }
        ];
        for (const position of positions) {
            page.drawText(label, { x: position.x, y: position.y, rotate: degrees(position.angle),
                size, font, color: rgb(119 / 255, 119 / 255, 119 / 255), opacity: 1 });
        }
        page.pushOperators(popGraphicsState());
    }
    // Existing image streams are copied as-is; only vector text is added.
    return pdf.save({ useObjectStreams: true, addDefaultPage: false });
}

function positive(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function pruneCache(root, keep) {
    const entries = [];
    const cutoff = Date.now() - positive(process.env.ACCESS_PDF_CACHE_HOURS, 6) * 3600000;
    let total = 0;
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.pdf$/.test(entry.name)) continue;
        const file = path.join(root, entry.name);
        const stat = await fs.promises.stat(file).catch(() => null);
        if (!stat) continue;
        total += stat.size;
        if (file !== keep) entries.push({ file, ...stat });
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const limit = positive(process.env.ACCESS_PDF_CACHE_MB, 1024) * 1024 * 1024;
    for (const entry of entries) {
        if (entry.mtimeMs >= cutoff && total <= limit) continue;
        await fs.promises.unlink(entry.file).catch(() => {});
        total -= entry.size;
    }
}

async function getMarkedPdf(source, code, cacheRoot) {
    const label = formatVersionLabel(code);
    const stat = await fs.promises.stat(source);
    const key = crypto.createHash('sha256').update(JSON.stringify({ source: path.resolve(source),
        size: stat.size, modified: stat.mtimeMs, label, style: STYLE })).digest('hex');
    const output = path.join(cacheRoot, key + '.pdf');
    const cached = await fs.promises.stat(output).catch(() => null);
    if (cached && cached.size > 0) {
        await fs.promises.utimes(output, new Date(), new Date()).catch(() => {});
        return output;
    }
    if (pending.has(output)) return pending.get(output);
    if (pending.size >= 64) throw new Error('Fila de preparação ocupada.');
    const work = queue.then(async () => {
        const temporary = path.join(cacheRoot, key + '.' + crypto.randomUUID());
        const stamped = temporary + '.stamped';
        const linearized = temporary + '.linearized';
        try {
            await fs.promises.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
            await fs.promises.writeFile(stamped, await stampPdf(await fs.promises.readFile(source), code), { mode: 0o600 });
            try {
                await run(process.env.QPDF_BIN || 'qpdf', ['--linearize', '--stream-data=preserve', '--deterministic-id', stamped, linearized],
                    { timeout: 180000 });
            } catch (error) { if (error.code !== 3) throw error; }
            const after = await fs.promises.stat(source);
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('PDF alterado durante a preparação.');
            if ((await fs.promises.stat(linearized)).size === 0) throw new Error('PDF gerado vazio.');
            await fs.promises.rename(linearized, output);
            await pruneCache(cacheRoot, output).catch(error => console.warn('[PDF CACHE]', error.message));
            return output;
        } finally {
            await Promise.all([stamped, linearized].map(file => fs.promises.unlink(file).catch(() => {})));
        }
    });
    queue = work.catch(() => {});
    pending.set(output, work);
    try { return await work; }
    finally { pending.delete(output); }
}

module.exports = { stampPdf, getMarkedPdf };
