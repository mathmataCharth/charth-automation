'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const script = fs.readFileSync(path.resolve(__dirname, '../public/admin/js/image-preview.js'), 'utf8');

function pilot(mode = 'images') {
    const elements = new Map(), requests = [], blobs = new Map(), timers = new Map(), holds = new Map();
    const revoked = [], pdfOpened = [];
    let serial = 0, clock = 0, fail = null;
    const prefix = '/admin/links/1/preview';
    function element(id) {
        if (elements.has(id)) return elements.get(id);
        const classes = new Set();
        const value = { id, style: {}, hidden: true, value: '1', disabled: false, clientWidth: 1000,
            dataset: { prefix, mode, page: '1' }, listeners: {},
            classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
            addEventListener(name, callback) { this.listeners[name] = callback; },
            decode: async () => {}, blur() {}, getContext() {
                if (!this.context) this.context = { drawImage: off => { this.page = off.context.page; } };
                return this.context;
            } };
        elements.set(id, value);
        return value;
    }
    class Image {
        async decode() {
            const blob = blobs.get(this.src);
            this.naturalWidth = blob?.profile === 'detail' ? 4800 : 1800;
            this.naturalHeight = Math.round(this.naturalWidth * .704);
        }
    }
    const window = { innerWidth: 1200, devicePixelRatio: 1, location: {}, listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
        pdfjsLib: { GlobalWorkerOptions: {}, getDocument({ url }) {
            pdfOpened.push(url);
            const offset = Number(url.slice(-1)) * 2;
            return { promise: Promise.resolve({ numPages: 2, async getPage(local) {
                return { getViewport: ({ scale }) => ({ width: 842 * scale, height: 596 * scale }),
                    render({ canvasContext }) { canvasContext.page = local + offset; return { promise: Promise.resolve(), cancel() {} }; } };
            } }), destroy: async () => {} };
        } }
    };
    const context = vm.createContext({ window, Image, AbortController,
        document: { getElementById: element, addEventListener() {},
            createElement: name => element(name + (++serial)), head: { appendChild() {} } },
        performance: { now: () => ++clock }, requestAnimationFrame: callback => setImmediate(callback),
        setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        URL: { createObjectURL(blob) { const url = 'blob:' + (++serial); blobs.set(url, blob); return url; },
            revokeObjectURL(url) { revoked.push(url); } },
        fetch: async url => {
            requests.push(url);
            if (url.endsWith('/info')) return { ok: true, json: async () => mode === 'images' ?
                { version: 'version', pageCount: 4 } : { pageCount: 4, parts: [
                    { start: 1, end: 2, url: prefix + '/pdf/parts/v/0' },
                    { start: 3, end: 4, url: prefix + '/pdf/parts/v/1' }] } };
            if (holds.has(url)) await holds.get(url).promise;
            const failed = fail === url;
            if (failed) fail = null;
            return { ok: !failed, status: failed ? 503 : 200,
                json: async () => ({ error: 'Falha temporária' }),
                blob: async () => ({ size: 123456, profile: url.split('/').at(-1), url }),
                headers: { get: name => name === 'X-Preview-Cache' ? 'HIT' : 'prepare;dur=0' } };
        }
    });
    vm.runInContext(script, context);
    const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
    const go = async page => { element('page-number').value = String(page); element('page-number').listeners.change(); await settle(); };
    function hold(page) {
        const url = `${prefix}/images/version/${page}/view`;
        let release;
        holds.set(url, { promise: new Promise(resolve => { release = resolve; }) });
        return () => { release(); holds.delete(url); };
    }
    return { elements, requests, revoked, blobs, window, pdfOpened, settle, go, hold,
        click: async id => { element(id).listeners.click(); await settle(); },
        failPage: page => { fail = `${prefix}/images/version/${page}/view`; },
        runPrefetch: async () => { for (const [id, timer] of timers) if (timer.delay === 700) { timers.delete(id); timer.callback(); break; } await settle(); } };
}

test('the image pilot initially fetches one page, prefetches one neighbor and requests detail only on zoom', async () => {
    const p = pilot();
    await p.settle();
    assert.deepEqual(p.requests, ['/admin/links/1/preview/info', '/admin/links/1/preview/images/version/1/view']);
    assert.equal(p.elements.get('page-image').hidden, false);
    assert.equal(p.elements.get('page-canvas').hidden, true);
    assert.match(p.elements.get('first-time').textContent, /s$/);
    await p.runPrefetch();
    assert.ok(p.requests.at(-1).endsWith('/2/view'));
    const before = p.requests.length;
    await p.click('next');
    assert.equal(p.requests.length, before, 'the next page is already in memory');
    assert.equal(p.elements.get('page-number').value, 2);
    assert.ok(p.elements.get('mode-pdf').href.endsWith('?mode=pdf&page=2'));
    await p.click('zoom-in');
    assert.ok(p.requests.at(-1).endsWith('/2/detail'));
    assert.equal(p.elements.get('zoom-value').textContent, '150%');
    assert.match(p.elements.get('asset-details').textContent, /4800 px/);
    await p.click('fit');
    assert.equal(p.elements.get('zoom-value').textContent, '100%');
    assert.equal(p.pdfOpened.length, 0);
});

test('late image responses cannot replace a more recently selected page', async () => {
    const p = pilot();
    await p.settle();
    const release3 = p.hold(3), release4 = p.hold(4);
    await p.go(3);
    await p.go(4);
    release4();
    await p.settle();
    const visible = p.elements.get('page-image').src;
    assert.ok(p.blobs.get(visible).url.endsWith('/4/view'));
    release3();
    await p.settle();
    assert.equal(p.elements.get('page-image').src, visible);
    assert.equal(p.elements.get('page-number').value, 4);
});

test('failed pages can be retried and leaving the pilot releases image URLs', async () => {
    const p = pilot();
    await p.settle();
    p.failPage(2);
    await p.go(2);
    assert.equal(p.elements.get('retry').hidden, false);
    assert.match(p.elements.get('message').textContent, /Falha temporária/);
    await p.click('retry');
    assert.equal(p.elements.get('retry').hidden, true);
    assert.equal(p.elements.get('message').hidden, true);
    p.window.listeners.pagehide();
    assert.ok(p.revoked.length >= 2);
});

test('PDF comparison uses protected PDF blocks and never requests image conversion', async () => {
    const p = pilot('pdf');
    await p.settle();
    assert.deepEqual(p.requests, ['/admin/links/1/preview/pdf/info']);
    assert.ok(p.pdfOpened[0].endsWith('/pdf/parts/v/0'));
    assert.equal(p.elements.get('page-canvas').page, 1);
    assert.equal(p.elements.get('page-image').hidden, true);
    await p.go(4);
    assert.equal(p.elements.get('page-canvas').page, 4);
    assert.ok(p.pdfOpened.at(-1).endsWith('/pdf/parts/v/1'));
    assert.equal(p.elements.get('next').disabled, true);
});
