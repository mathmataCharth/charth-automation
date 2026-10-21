'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const { PDFDocument, degrees, decodePDFRawStream } = require('pdf-lib');
const { stampPdf, getMarkedPdf } = require('../src/services/watermarkService');
const { formatVersionLabel } = require('../src/utils/accessCode');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'watermark-pdf-'));
const previousCwd = process.cwd();
const previousUpload = process.env.UPLOAD_DIR;
process.chdir(folder);
process.env.UPLOAD_DIR = folder;
fs.mkdirSync(path.join(folder, 'data'));
const db = require('../src/config/database');
const { createDocument } = require('../src/services/documentService');
const { createLink, getLinkById } = require('../src/services/accessService');
let source, bytes, link1, link2, server, base, version;
let qpdfAvailable = true;
try { execFileSync(process.env.QPDF_BIN || 'qpdf', ['--version'], { stdio: 'ignore' }); }
catch (_) { qpdfAvailable = false; }

function pageText(pdf, page) {
    const contents = page.node.Contents();
    const refs = contents.asArray ? contents.asArray() : [contents];
    return refs.map(ref => Buffer.from(decodePDFRawStream(pdf.context.lookup(ref)).decode()).toString()).join('\n');
}

before(async () => {
    const pdf = await PDFDocument.create();
    for (const angle of [0, 90, 180, 270]) {
        const page = pdf.addPage([842, 604]);
        page.setCropBox(5, 8, 825, 580);
        page.setRotation(degrees(angle));
        page.drawText('Lookbook photography');
    }
    bytes = Buffer.from(await pdf.save());
    source = path.join(folder, 'original.pdf');
    fs.writeFileSync(source, bytes);
    version = randomUUID();
    const partsDir = path.join(source + '.parts', version);
    fs.mkdirSync(partsDir, { recursive: true });
    for (const [index, pages] of [[0, [0, 1]], [1, [2, 3]]]) {
        const block = await PDFDocument.create();
        for (const page of await block.copyPages(pdf, pages)) block.addPage(page);
        fs.writeFileSync(path.join(partsDir, `${index}.pdf`), await block.save());
    }
    const stamp = fs.statSync(source);
    const manifest = JSON.stringify({ version, pageCount: 4, source: { size: stamp.size, mtimeMs: stamp.mtimeMs },
        parts: [{ start: 1, end: 2 }, { start: 3, end: 4 }] });
    fs.writeFileSync(path.join(source + '.parts', 'current.json'), manifest);
    fs.writeFileSync(path.join(partsDir, 'manifest.json'), manifest);
    const document = createDocument('Lookbook', 'original.pdf', 'original.pdf', bytes.length, 4);
    link1 = createLink(document, 'first-access', 'First', '', 'hash1', null, null);
    link2 = createLink(document, 'second-access', 'Second', '', 'hash2', null, null);
    const app = express();
    app.use((req, res, next) => {
        req.session = req.get('x-test-viewer') === '1' ? {
            viewerTokens: { 'first-access': true, 'second-access': true },
            viewerOpenings: { 'first-access': true, 'second-access': true }
        } : {};
        next();
    });
    app.use('/api', require('../src/routes/api'));
    server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    process.chdir(previousCwd);
    if (previousUpload === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUpload;
    fs.rmSync(folder, { recursive: true, force: true });
});

test('three opaque gray versions follow the requested positions on every page and rotation', async () => {
    const stamped = await PDFDocument.load(await stampPdf(bytes, 'A001'));
    const original = await PDFDocument.load(bytes);
    assert.equal(stamped.getPageCount(), 4);
    for (let i = 0; i < 4; i++) {
        const page = stamped.getPages()[i];
        assert.deepEqual(page.getCropBox(), original.getPages()[i].getCropBox());
        assert.deepEqual(page.getRotation(), original.getPages()[i].getRotation());
        const content = pageText(stamped, page);
        assert.equal((content.match(/<56657273e36f3a323032375f41303031>/gi) || []).length, 3);
        assert.ok(!/\bre\b/.test(content), 'no background rectangle covers the photograph');
        assert.match(content, /0 Tr/, 'text uses a solid fill');
        const gray = (content.match(/([\d.]+) ([\d.]+) ([\d.]+) rg/g) || []).filter(operation => {
            const channels = operation.split(' ').slice(0, 3).map(Number);
            return channels.every(channel => Math.abs(channel - 119 / 255) < 0.000001);
        });
        assert.equal(gray.length, 3, 'all three labels use #777777');
        const matrices = [...content.matchAll(/([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) Tm/g)]
            .slice(-3).map(match => match.slice(1).map(Number));
        const crop = page.getCropBox();
        const landscapeAxes = page.getRotation().angle % 180 === 0;
        const w = landscapeAxes ? crop.width : crop.height;
        const h = landscapeAxes ? crop.height : crop.width;
        assert.equal(matrices.length, 3);
        assert.ok(matrices[0][4] > w * 0.35 && matrices[0][4] < w * 0.6 && matrices[0][5] > h * 0.96, 'top center');
        assert.ok(matrices[1][4] < w * 0.08 && matrices[1][5] > h * 0.3 && matrices[1][5] < h * 0.6, 'left center');
        assert.ok(Math.abs(matrices[1][1] - 1) < 0.000001 && Math.abs(matrices[1][2] + 1) < 0.000001, 'left label reads vertically');
        assert.ok(matrices[2][4] > w * 0.8 && matrices[2][5] > h * 0.1 && matrices[2][5] < h * 0.16, 'lower right, above the former footer');
        assert.ok(!/\/ca\s+0\./.test(content));
    }
    await assert.rejects(stampPdf(bytes, '1234'), /inválido/);
    await assert.rejects(stampPdf(Buffer.from('not PDF'), 'A001'));
    assert.deepEqual(fs.readFileSync(source), bytes);
});

test('cache is shared only for the same source and access code; concurrent requests reuse one result', { skip: !qpdfAvailable }, async () => {
    const cache = source + '.parts/cache-tests';
    const [first, repeated] = await Promise.all([getMarkedPdf(source, 'A001', cache), getMarkedPdf(source, 'A001', cache)]);
    assert.equal(first, repeated);
    const other = await getMarkedPdf(source, 'A002', cache);
    assert.notEqual(first, other);
    const firstPdf = await PDFDocument.load(fs.readFileSync(first));
    const otherPdf = await PDFDocument.load(fs.readFileSync(other));
    assert.match(pageText(firstPdf, firstPdf.getPages()[0]), /<56657273e36f3a323032375f41303031>/i);
    assert.match(pageText(otherPdf, otherPdf.getPages()[0]), /<56657273e36f3a323032375f41303032>/i);
    assert.ok(!/<56657273e36f3a323032375f41303032>/i.test(pageText(firstPdf, firstPdf.getPages()[0])));
    assert.deepEqual(fs.readFileSync(source), bytes);
});

test('protected document API delivers each access code inside the PDF and supports ranges', { skip: !qpdfAvailable }, async () => {
    const unauthenticated = await fetch(base + '/api/pdf/first-access/document');
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();
    for (const [token, id] of [['first-access', link1], ['second-access', link2]]) {
        const response = await fetch(`${base}/api/pdf/${token}/document`, { headers: { 'x-test-viewer': '1' } });
        assert.equal(response.status, 200);
        const body = Buffer.from(await response.arrayBuffer());
        assert.ok(!body.equals(bytes));
        const pdf = await PDFDocument.load(body);
        const expected = Buffer.from(formatVersionLabel(getLinkById(id).version_code), 'latin1').toString('hex');
        assert.match(pageText(pdf, pdf.getPages()[0]), new RegExp('<' + expected + '>', 'i'));
        const range = await fetch(`${base}/api/pdf/${token}/document`, { headers: { 'x-test-viewer': '1', range: 'bytes=0-99' } });
        assert.equal(range.status, 206);
        assert.deepEqual(Buffer.from(await range.arrayBuffer()), body.subarray(0, 100));
    }
});

test('generation failure returns an error instead of exposing the unmarked original', async () => {
    const previous = process.env.QPDF_BIN;
    process.env.QPDF_BIN = path.join(folder, 'missing-qpdf');
    // A different source stamp prevents reuse of a previously generated file.
    fs.appendFileSync(source, '\n% another source revision');
    try {
        const response = await fetch(base + '/api/pdf/first-access/document', { headers: { 'x-test-viewer': '1' } });
        assert.equal(response.status, 503);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.ok(!(await response.text()).includes('%PDF'));
    } finally {
        if (previous === undefined) delete process.env.QPDF_BIN;
        else process.env.QPDF_BIN = previous;
    }
});

test('each PDF block is marked on the server for the requesting access', { skip: !qpdfAvailable }, async () => {
    for (const [token, id] of [['first-access', link1], ['second-access', link2]]) {
        for (const index of [0, 1]) {
            const response = await fetch(`${base}/api/pdf/${token}/parts/${version}/${index}`, { headers: { 'x-test-viewer': '1' } });
            assert.equal(response.status, 200);
            const pdf = await PDFDocument.load(await response.arrayBuffer());
            assert.equal(pdf.getPageCount(), 2);
            const expected = Buffer.from(formatVersionLabel(getLinkById(id).version_code), 'latin1').toString('hex');
            for (const page of pdf.getPages()) {
                assert.equal((pageText(pdf, page).match(new RegExp('<' + expected + '>', 'gi')) || []).length, 3);
            }
        }
    }
});
