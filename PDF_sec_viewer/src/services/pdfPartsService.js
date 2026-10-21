'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

function positiveInt(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function pageRanges(total, first = 5, size = 20) {
    const ranges = [];
    for (let start = 1; start <= total;) {
        const end = Math.min(total, start + (start === 1 ? first : size) - 1);
        ranges.push({ start, end });
        start = end + 1;
    }
    return ranges;
}

function sourceStamp(file) {
    const stat = fs.statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function readManifest(file, version) {
    try {
        if (version && !/^[a-f0-9-]{36}$/.test(version)) return null;
        const root = file + '.parts';
        const manifest = JSON.parse(fs.readFileSync(version
            ? path.join(root, version, 'manifest.json') : path.join(root, 'current.json'), 'utf8'));
        if (!/^[a-f0-9-]{36}$/.test(manifest.version) ||
            (version && manifest.version !== version) || !Array.isArray(manifest.parts) ||
            manifest.parts.length === 0) return null;
        let next = 1;
        for (const part of manifest.parts) {
            if (part.start !== next || !Number.isSafeInteger(part.end) || part.end < part.start) return null;
            next = part.end + 1;
        }
        if (next !== manifest.pageCount + 1) return null;
        // An open viewer may finish reading its immutable version after reprocessing.
        if (!version) {
            const stamp = sourceStamp(file);
            if (stamp.size !== manifest.source.size || stamp.mtimeMs !== manifest.source.mtimeMs) return null;
        }
        return manifest;
    } catch (_) {
        return null;
    }
}

async function prepareParts(file) {
    const source = sourceStamp(file);
    const qpdf = process.env.QPDF_BIN || 'qpdf';
    const { stdout } = await run(qpdf, ['--show-npages', file], { timeout: 120000 });
    const pageCount = positiveInt(stdout.trim(), 0);
    if (!pageCount) throw new Error('Não foi possível contar as páginas do PDF.');
    const parts = pageRanges(pageCount,
        positiveInt(process.env.PDF_FIRST_BLOCK_PAGES, 5),
        positiveInt(process.env.PDF_BLOCK_PAGES, 20));
    const existing = readManifest(file);
    if (existing && existing.imageStreamsPreserved === true && JSON.stringify(existing.parts) === JSON.stringify(parts) &&
        existing.parts.every((_, index) => fs.existsSync(path.join(file + '.parts', existing.version, `${index}.pdf`)))) {
        return existing;
    }
    const version = randomUUID();
    const root = file + '.parts';
    const folder = path.join(root, version);
    fs.mkdirSync(folder, { recursive: true });
    const pending = path.join(root, `${version}.json`);
    try {
        // Publish only after every part is complete. Never replace the source PDF.
        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            const output = path.join(folder, `${index}.pdf`);
            try {
                await run(qpdf, ['--empty', '--linearize', '--stream-data=preserve', '--pages', file,
                    `${part.start}-${part.end}`, '--', output], { timeout: 180000 });
            } catch (error) {
                if (error.code !== 3) throw error; // qpdf: warnings only
            }
            if (fs.statSync(output).size === 0) throw new Error('Bloco PDF vazio.');
        }
        const after = sourceStamp(file);
        if (after.size !== source.size || after.mtimeMs !== source.mtimeMs) {
            throw new Error('PDF alterado durante a preparação. Execute novamente.');
        }
        const manifest = { version, source, pageCount, parts, imageStreamsPreserved: true };
        const json = JSON.stringify(manifest);
        fs.writeFileSync(path.join(folder, 'manifest.json'), json);
        fs.writeFileSync(pending, json);
        fs.renameSync(pending, path.join(root, 'current.json'));
        return manifest;
    } catch (error) {
        // Both paths are derived from the UUID created above, under this PDF's root.
        fs.rmSync(folder, { recursive: true, force: true });
        fs.rmSync(pending, { force: true });
        throw error;
    }
}

module.exports = { prepareParts, readManifest, pageRanges };
