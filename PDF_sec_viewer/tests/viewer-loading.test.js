'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '../public/viewer/js/viewer.js'), 'utf8');

function viewer({ legacy = false } = {}) {
    const elements = new Map();
    const opened = [], destroyed = [], drawn = [], idle = [];
    const starts = [1, 6, 26, 46, 66];
    let fail = null;
    function element(id) {
        if (elements.has(id)) return elements.get(id);
        const element = {
            id, style: {}, value: 1, clientWidth: 800, listeners: {},
            dataset: { url: '/whole', info: '/info', pages: '228' },
            addEventListener(name, callback) { this.listeners[name] = callback; },
            remove() {}, getContext() {
                if (!this.context) this.context = { drawImage: (image) => drawn.push(image.page) };
                return this.context;
            }
        };
        elements.set(id, element);
        return element;
    }
    const parts = starts.map((start, index) => ({ start,
        end: index === starts.length - 1 ? 228 : starts[index + 1] - 1,
        url: `/block${index}` }));
    const context = vm.createContext({
        console: { error() {} }, setTimeout: (callback) => idle.push(callback),
        window: { devicePixelRatio: 1, requestIdleCallback: (callback) => idle.push(callback) },
        document: {
            getElementById: element, addEventListener() {},
            createElement: () => element(`offscreen${elements.size}`),
            body: { appendChild() {} }
        },
        createImageBitmap: async (off) => ({ width: off.width, height: off.height,
            page: off.context.page, close() {} }),
        fetch: async (url) => {
            assert.equal(url, '/info');
            return { ok: true, json: async () => ({ pageCount: legacy ? null : 228,
                parts: legacy ? null : parts, url: '/whole' }) };
        },
        pdfjsLib: {
            GlobalWorkerOptions: {},
            getDocument({ url }) {
                opened.push(url);
                const index = url === '/whole' ? 0 : Number(url.slice(-1));
                const promise = fail === url ? Promise.reject(new Error('network error')) : Promise.resolve({
                    numPages: legacy ? 228 : parts[index].end - parts[index].start + 1,
                    async getPage(local) {
                        const global = (legacy ? 1 : starts[index]) + local - 1;
                        return {
                            getViewport: ({ scale }) => ({ width: 100 * scale, height: 150 * scale }),
                            render({ canvasContext }) {
                                canvasContext.page = global;
                                return { promise: Promise.resolve(), cancel() {} };
                            }
                        };
                    }
                });
                fail = null;
                return { promise, async destroy() { destroyed.push(url); } };
            }
        }
    });
    vm.runInContext(source, context);
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
    const go = async (num) => { vm.runInContext(`queueRenderPage(${num})`, context); await settle(); };
    return { elements, opened, destroyed, drawn, idle, settle, go, context,
        failNext: (url) => { fail = url; } };
}

test('initial load fetches only the first block; navigation maps global pages across blocks', async () => {
    const v = viewer();
    await v.settle();
    assert.deepEqual(v.opened, ['/block0']);
    assert.equal(v.drawn.at(-1), 1);
    assert.equal(v.elements.get('total-pages').textContent, 228);
    await v.go(5);
    assert.equal(v.drawn.at(-1), 5);
    // Run the idle prefetch at the first block boundary.
    for (const callback of v.idle.splice(0)) await callback();
    await v.settle();
    assert.deepEqual(v.opened, ['/block0', '/block1']);
    assert.equal(v.drawn.at(-1), 5); // prefetch never changes the displayed page
    await v.go(6);
    assert.equal(v.drawn.at(-1), 6);
    await v.go(228);
    assert.equal(v.drawn.at(-1), 228);
    assert.equal(v.elements.get('btn-next').disabled, true);
});

test('document cache is bounded while jumping between distant blocks and returning', async () => {
    const v = viewer();
    await v.settle();
    for (const page of [6, 26, 46, 228, 1]) await v.go(page);
    assert.equal(v.drawn.at(-1), 1);
    assert.ok(v.destroyed.length >= 2);
    assert.ok(vm.runInContext('blockDocuments.size', v.context) <= 3);
    v.elements.get('btn-zoom-in').listeners.click();
    await v.settle();
    assert.equal(v.drawn.at(-1), 1);
    assert.equal(v.elements.get('zoom-label').textContent, '70%');
});

test('failed block loads can be retried without a full reload', async () => {
    const v = viewer();
    await v.settle();
    v.failNext('/block1');
    await v.go(6);
    assert.equal(v.drawn.at(-1), 1);
    await v.go(6);
    assert.equal(v.drawn.at(-1), 6);
});

test('unprepared documents retain their real page count and original PDF loading', async () => {
    const v = viewer({ legacy: true });
    await v.settle();
    assert.deepEqual(v.opened, ['/whole']);
    assert.equal(v.elements.get('total-pages').textContent, 228);
    await v.go(228);
    assert.equal(v.drawn.at(-1), 228);
});
