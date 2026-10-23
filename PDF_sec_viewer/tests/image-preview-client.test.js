'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const script = fs.readFileSync(path.resolve(__dirname, '../public/admin/js/image-preview.js'), 'utf8');

function pilot(mode = 'images', { width = 1000, height = 800, padding = 20 } = {}) {
    const elements = new Map(), requests = [], blobs = new Map(), timers = new Map(), holds = new Map();
    const revoked = [], pdfOpened = [];
    let serial = 0, clock = 0, fail = null;
    const prefix = '/admin/links/1/preview';
    function element(id) {
        if (elements.has(id)) return elements.get(id);
        const classes = new Set();
        const value = { id, style: {}, hidden: true, value: '1', disabled: false, clientWidth: width, clientHeight: height,
            dataset: { prefix, mode, page: '1' }, listeners: {}, attributes: {},
            setAttribute(name, value) { this.attributes[name] = value; },
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
        getComputedStyle: () => ({ paddingLeft: String(padding), paddingRight: String(padding), paddingTop: String(padding), paddingBottom: String(padding) }),
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
    function hold(page, profile = 'view') {
        const url = `${prefix}/images/version/${page}/${profile}`;
        let release;
        holds.set(url, { promise: new Promise(resolve => { release = resolve; }) });
        return () => { release(); holds.delete(url); };
    }
    return { elements, requests, revoked, blobs, window, pdfOpened, settle, go, hold,
        selectZoom: async value => { element('zoom-value').value = String(value); element('zoom-value').listeners.change(); await settle(); },
        click: async id => { element(id).listeners.click(); await settle(); },
        failPage: page => { fail = `${prefix}/images/version/${page}/view`; },
        runStatusDelay: async () => { for (const [id, timer] of timers) if (timer.delay === 200) { timers.delete(id); timer.callback(); break; } await settle(); },
        runPrefetch: async () => { for (const [id, timer] of timers) if (timer.delay === 700) { timers.delete(id); timer.callback(); break; } await settle(); } };
}

test('the image pilot initially fetches one page, prefetches one neighbor and requests detail only on zoom', async () => {
    const p = pilot();
    await p.settle();
    assert.deepEqual(p.requests, ['/admin/links/1/preview/info', '/admin/links/1/preview/images/version/1/view']);
    assert.equal(p.elements.get('page-image').hidden, false);
    assert.equal(p.elements.get('page-canvas').hidden, true);
    assert.equal(p.elements.get('zoom-value').value, '75');
    assert.equal(p.elements.get('page-image').style.width, '720px');
    assert.match(p.elements.get('first-time').textContent, /s$/);
    await p.runPrefetch();
    assert.ok(p.requests.at(-1).endsWith('/2/view'));
    const before = p.requests.length;
    await p.click('next');
    assert.equal(p.requests.length, before, 'the next page is already in memory');
    assert.equal(p.elements.get('page-number').value, 2);
    assert.ok(p.elements.get('mode-pdf').href.endsWith('?mode=pdf&page=2'));
    await p.click('zoom-in');
    assert.equal(p.elements.get('zoom-value').value, '80');
    assert.equal(p.requests.length, before, 'a 5% change reuses the decoded image');
    await p.selectZoom(130);
    assert.ok(p.requests.at(-1).endsWith('/2/detail'));
    assert.equal(p.elements.get('zoom-value').value, '130');
    assert.match(p.elements.get('asset-details').textContent, /4800 px/);
    await p.click('fit');
    assert.equal(p.elements.get('zoom-value').value, '100');
    assert.equal(p.pdfOpened.length, 0);
});

test('slow pages keep the current decoded image and scroll position until the next page is ready', async () => {
    const p = pilot();
    await p.settle();
    const image = p.elements.get('page-image'), stage = p.elements.get('preview');
    const current = { src: image.src, width: image.style.width, height: image.height };
    stage.scrollTop = 160; stage.scrollLeft = 45;
    const release = p.hold(2);
    await p.go(2);
    assert.equal(stage.attributes['aria-busy'], 'true');
    assert.equal(p.elements.get('page-status').hidden, true, 'brief loads do not flash the badge');
    await p.runStatusDelay();
    assert.equal(p.elements.get('page-status').hidden, false);
    assert.deepEqual({ src: image.src, width: image.style.width, height: image.height }, current);
    assert.equal(image.hidden, false);
    assert.equal(stage.scrollTop, 160);
    assert.equal(stage.scrollLeft, 45);
    release(); await p.settle();
    assert.ok(p.blobs.get(image.src).url.endsWith('/2/view'));
    assert.equal(p.elements.get('page-status').hidden, true);
    assert.equal(stage.attributes['aria-busy'], 'false');
    assert.equal(stage.scrollTop, 0);
    assert.equal(stage.scrollLeft, 0);
});

test('zoom preserves the reading position and cached transitions cancel the loading badge', async () => {
    const p = pilot();
    await p.settle();
    const stage = p.elements.get('preview');
    stage.scrollTop = 140; stage.scrollLeft = 55;
    await p.click('zoom-in');
    assert.equal(p.elements.get('zoom-value').value, '80');
    assert.equal(stage.scrollTop, 140);
    assert.equal(stage.scrollLeft, 55);
    await p.runStatusDelay();
    assert.equal(p.elements.get('page-status').hidden, true);
});

test('fit uses both screen dimensions and a selected zoom stays in 5% steps through page navigation', async () => {
    const p = pilot('images', { width: 1900, height: 840, padding: 8 });
    await p.settle();
    assert.equal(p.elements.get('zoom-value').value, '75');
    await p.click('fit');
    assert.equal(p.elements.get('zoom-value').value, '60');
    const displayedWidth = parseFloat(p.elements.get('page-image').style.width);
    assert.ok(displayedWidth <= 1884);
    assert.ok(displayedWidth * .704 <= 824);
    await p.click('zoom-in');
    assert.equal(p.elements.get('zoom-value').value, '65');
    await p.go(2);
    assert.equal(p.elements.get('zoom-value').value, '65');
    await p.click('zoom-out');
    assert.equal(p.elements.get('zoom-value').value, '60');
    await p.selectZoom(300);
    assert.equal(p.elements.get('zoom-in').disabled, true);
    await p.selectZoom(25);
    assert.equal(p.elements.get('zoom-out').disabled, true);
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
    assert.equal(p.elements.get('page-status').hidden, false);
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
