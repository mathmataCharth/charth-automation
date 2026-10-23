'use strict';

// === Security: Block keyboard shortcuts ===
document.addEventListener('keydown', function (e) {
    const key = e.key || e.keyCode;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && (key === 'p' || key === 'P' || e.keyCode === 80)) { e.preventDefault(); e.stopPropagation(); return false; }
    if (ctrl && (key === 's' || key === 'S' || e.keyCode === 83)) { e.preventDefault(); return false; }
    if (ctrl && e.shiftKey && (key === 'i' || key === 'I' || e.keyCode === 73)) { e.preventDefault(); return false; }
    if (ctrl && e.shiftKey && (key === 'j' || key === 'J' || e.keyCode === 74)) { e.preventDefault(); return false; }
    if (ctrl && (key === 'u' || key === 'U' || e.keyCode === 85)) { e.preventDefault(); return false; }
    if (key === 'F12' || e.keyCode === 123) { e.preventDefault(); return false; }
    if (key === 'PrintScreen' || e.keyCode === 44) { e.preventDefault(); return false; }
    if (ctrl && (key === 'a' || key === 'A' || e.keyCode === 65)) { e.preventDefault(); return false; }
    if (ctrl && (key === 'c' || key === 'C' || e.keyCode === 67)) { e.preventDefault(); return false; }
}, true);

document.addEventListener('contextmenu', function (e) { e.preventDefault(); return false; }, true);
document.addEventListener('dragstart',   function (e) { e.preventDefault(); return false; }, true);
document.addEventListener('drop',        function (e) { e.preventDefault(); return false; }, true);
document.addEventListener('selectstart', function (e) { e.preventDefault(); return false; }, true);

// === PDF Viewer State ===
const canvas = document.getElementById('pdf-canvas');
const pdfUrl = canvas.dataset.url;
const infoUrl = canvas.dataset.info;
const totalPagesFromAttr = parseInt(canvas.dataset.pages, 10) || 1;

const ctx = canvas.getContext('2d', { alpha: false });

let pdfDoc = null;
let currentPage = 1;
let currentScale = 0.75;
let rendering = false;
let pageNumPending = null;
let currentRenderTask = null;

// Cache LRU de páginas já renderizadas (ImageBitmap)
const RENDER_CACHE_SIZE = 6;
const renderCache = new Map(); // key = `${pageNum}:${scale}` → ImageBitmap

// Cache de PDFPageProxy (páginas já buscadas do arquivo)
const pageProxyCache = new Map();
const blockDocuments = new Map();
let documentParts = [];
let prefetchGeneration = 0;
const prefetches = new Set();

function blockForPage(num) {
    return documentParts.findIndex(function (part) { return num >= part.start && num <= part.end; });
}

async function withPage(num, callback) {
    const index = blockForPage(num);
    if (index < 0) throw new Error('Página indisponível.');
    let entry = blockDocuments.get(index);
    if (!entry) {
        const task = pdfjsLib.getDocument({
            url: documentParts[index].url,
            disableStream: true,
            disableAutoFetch: true,
            rangeChunkSize: 262144
        });
        entry = { task, promise: task.promise, users: 0 };
        blockDocuments.set(index, entry);
        task.promise.catch(function () {
            if (blockDocuments.get(index) === entry) blockDocuments.delete(index);
        });
    }
    entry.users++;
    // Move to the end for LRU eviction.
    blockDocuments.delete(index);
    blockDocuments.set(index, entry);
    try {
        const document = await entry.promise;
        let page = pageProxyCache.get(num);
        if (!page) {
            page = await document.getPage(num - documentParts[index].start + 1);
            pageProxyCache.set(num, page);
        }
        return await callback(page);
    } finally {
        entry.users--;
        for (const [oldIndex, oldEntry] of blockDocuments) {
            if (blockDocuments.size <= 3) break;
            if (oldEntry.users) continue;
            blockDocuments.delete(oldIndex);
            const part = documentParts[oldIndex];
            for (const page of pageProxyCache.keys()) {
                if (page >= part.start && page <= part.end) pageProxyCache.delete(page);
            }
            oldEntry.task.destroy().catch(function () {});
        }
    }
}

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// DPI adaptativo (evita oversampling mas mantém nitidez em Retina)
const DPR = Math.min(window.devicePixelRatio || 1, 2);

// Toolbar elements
const btnPrev     = document.getElementById('btn-prev');
const btnNext     = document.getElementById('btn-next');
const pageInput   = document.getElementById('page-input');
const totalSpan   = document.getElementById('total-pages');
const btnZoomOut  = document.getElementById('btn-zoom-out');
const btnZoomIn   = document.getElementById('btn-zoom-in');
const btnZoomFit  = document.getElementById('btn-zoom-fit');
const zoomLabel   = document.getElementById('zoom-label');

// Loading indicator
const loadingMsg = document.createElement('div');
loadingMsg.id = 'loading-msg';
loadingMsg.textContent = 'Carregando documento...';
document.body.appendChild(loadingMsg);

function updateToolbar() {
    const total = pdfDoc ? pdfDoc.numPages : totalPagesFromAttr;
    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= total;
    pageInput.value = currentPage;
    totalSpan.textContent = total;
    zoomLabel.textContent = Math.round(currentScale * 100) + '%';
}

function cacheKey(num, scale) {
    return num + ':' + scale.toFixed(2);
}

function pruneCache() {
    while (renderCache.size > RENDER_CACHE_SIZE) {
        const firstKey = renderCache.keys().next().value;
        const bitmap = renderCache.get(firstKey);
        if (bitmap && bitmap.close) bitmap.close();
        renderCache.delete(firstKey);
    }
}

async function renderPage(num, isPrefetch) {
    if (!pdfDoc) return;

    const scale = currentScale;
    const key = cacheKey(num, scale);

    // Se já temos no cache e não é prefetch, desenha direto
    if (renderCache.has(key) && !isPrefetch) {
        const bitmap = renderCache.get(key);
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.style.width = (bitmap.width / DPR) + 'px';
        canvas.style.height = (bitmap.height / DPR) + 'px';
        ctx.drawImage(bitmap, 0, 0);
        currentPage = num;
        updateToolbar();
        loadingMsg.remove();
        // Atualiza LRU movendo para o fim
        renderCache.delete(key);
        renderCache.set(key, bitmap);
        schedulePrefetch(num);
        return;
    }

    if (!isPrefetch) {
        rendering = true;
        loadingMsg.textContent = 'Carregando página...';
        document.body.appendChild(loadingMsg);
        // Cancela render anterior se estiver em progresso
        if (currentRenderTask) {
            try { currentRenderTask.cancel(); } catch (e) {}
        }
    }

    try {
        const bitmap = await withPage(num, async function (page) {
            const viewport = page.getViewport({ scale: scale * DPR });

            // Render em canvas offscreen para permitir cache
            const off = document.createElement('canvas');
            off.width = viewport.width;
            off.height = viewport.height;
            const offCtx = off.getContext('2d', { alpha: false });

            const task = page.render({
                canvasContext: offCtx,
                viewport: viewport
            });
            if (!isPrefetch) currentRenderTask = task;

            await task.promise;

            // Transforma em ImageBitmap para guardar em cache (libera memória do canvas)
            let bitmap;
            try {
                bitmap = await createImageBitmap(off);
            } catch (e) {
                // Fallback: se createImageBitmap falhar, usa o canvas direto
                bitmap = off;
            }

            return bitmap;
        });

        // A zoom change may have happened while this page was rendering.
        if (scale !== currentScale) {
            if (bitmap.close) bitmap.close();
            if (!isPrefetch) {
                rendering = false;
                currentRenderTask = null;
                const pending = pageNumPending === null ? num : pageNumPending;
                pageNumPending = null;
                renderPage(pending);
            }
            return;
        }
        const previous = renderCache.get(key);
        if (previous && previous.close) previous.close();
        renderCache.set(key, bitmap);
        pruneCache();

        if (!isPrefetch) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.style.width = (bitmap.width / DPR) + 'px';
            canvas.style.height = (bitmap.height / DPR) + 'px';
            ctx.drawImage(bitmap, 0, 0);
            currentPage = num;
            updateToolbar();
            loadingMsg.remove();
            rendering = false;
            currentRenderTask = null;

            if (pageNumPending !== null) {
                const p = pageNumPending;
                pageNumPending = null;
                renderPage(p);
            } else {
                schedulePrefetch(num);
            }
        }
    } catch (err) {
        if (err && err.name === 'RenderingCancelledException') return;
        if (!isPrefetch) {
            rendering = false;
            currentRenderTask = null;
            loadingMsg.textContent = 'Erro ao carregar a página. Tente novamente ou recarregue.';
            document.body.appendChild(loadingMsg);
            pageNumPending = null;
            console.error('Render error:', err);
        }
    }
}

function schedulePrefetch(num) {
    // Pré-renderiza a próxima página em background (se não estiver em cache)
    if (!pdfDoc) return;
    const next = num + 1;
    if (next > pdfDoc.numPages) return;
    const key = cacheKey(next, currentScale);
    if (renderCache.has(key) || prefetches.has(key)) return;
    const generation = ++prefetchGeneration;

    // Usa requestIdleCallback se disponível, senão setTimeout
    const schedule = window.requestIdleCallback || function (cb) { return setTimeout(cb, 100); };
    schedule(async function () {
        if (generation !== prefetchGeneration || rendering || renderCache.has(key) || prefetches.has(key)) return;
        prefetches.add(key);
        try { await renderPage(next, true); }
        finally { prefetches.delete(key); }
    });
}

function queueRenderPage(num) {
    prefetchGeneration++;
    if (rendering) {
        pageNumPending = num;
    } else {
        renderPage(num);
    }
}

function invalidateCacheOnScaleChange() {
    // Ao mudar zoom, páginas em cache com scale antigo ficam inválidas
    // Mantemos só por um tempo — o pruneCache vai removê-las naturalmente
    // Mas força limpeza das que não são da página atual para liberar memória
    for (const key of Array.from(renderCache.keys())) {
        if (!key.endsWith(':' + currentScale.toFixed(2))) {
            const bm = renderCache.get(key);
            if (bm && bm.close) bm.close();
            renderCache.delete(key);
        }
    }
}

function fitToWindow() {
    if (!pdfDoc) return;
    withPage(currentPage, function (page) {
        const container = document.getElementById('canvas-container');
        const containerWidth = container.clientWidth - 32;
        const naturalViewport = page.getViewport({ scale: 1 });
        currentScale = containerWidth / naturalViewport.width;
        invalidateCacheOnScaleChange();
        queueRenderPage(currentPage);
    }).catch(function (error) {
        console.error('Fit error:', error);
    });
}

// Fetch only the page map, then open the first small PDF block.
async function loadDocument() {
    const response = await fetch(infoUrl, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Documento indisponível.');
    const info = await response.json();
    documentParts = info.parts || [{ start: 1, end: info.pageCount || totalPagesFromAttr, url: pdfUrl }];
    // Legacy documents with unknown page counts still use their real PDF count.
    if (!info.parts) {
        const task = pdfjsLib.getDocument({ url: info.url || pdfUrl,
            disableStream: true, disableAutoFetch: true, rangeChunkSize: 262144 });
        blockDocuments.set(0, { task, promise: task.promise, users: 0 });
        const pdf = await task.promise;
        documentParts[0].end = pdf.numPages;
        info.pageCount = pdf.numPages;
    }
    pdfDoc = { numPages: info.pageCount };
    totalSpan.textContent = pdfDoc.numPages;
    pageInput.max = pdfDoc.numPages;
    await renderPage(1);
}

loadDocument().catch(function (err) {
    loadingMsg.textContent = 'Erro ao carregar o documento. Tente recarregar a página.';
    console.error('PDF load error:', err);
});

// Toolbar handlers
btnPrev.addEventListener('click', function () {
    if (currentPage <= 1) return;
    queueRenderPage(currentPage - 1);
});

btnNext.addEventListener('click', function () {
    if (!pdfDoc || currentPage >= pdfDoc.numPages) return;
    queueRenderPage(currentPage + 1);
});

pageInput.addEventListener('change', function () {
    if (!pdfDoc) return;
    const num = parseInt(pageInput.value, 10);
    if (isNaN(num)) return;
    const clamped = Math.max(1, Math.min(pdfDoc.numPages, num));
    queueRenderPage(clamped);
});

pageInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') pageInput.dispatchEvent(new Event('change'));
});

btnZoomIn.addEventListener('click', function () {
    currentScale = Math.min(4.0, (Math.round(currentScale * 100) + 5) / 100);
    invalidateCacheOnScaleChange();
    queueRenderPage(currentPage);
});

btnZoomOut.addEventListener('click', function () {
    currentScale = Math.max(0.25, (Math.round(currentScale * 100) - 5) / 100);
    invalidateCacheOnScaleChange();
    queueRenderPage(currentPage);
});

btnZoomFit.addEventListener('click', function () {
    fitToWindow();
});

document.addEventListener('keydown', function (e) {
    if (!pdfDoc) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        if (currentPage < pdfDoc.numPages) queueRenderPage(currentPage + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (currentPage > 1) queueRenderPage(currentPage - 1);
    }
});
