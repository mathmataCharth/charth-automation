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
const totalPagesFromAttr = parseInt(canvas.dataset.pages, 10) || 1;

const ctx = canvas.getContext('2d', { alpha: false });

let pdfDoc = null;
let currentPage = 1;
let currentScale = 1.5;
let rendering = false;
let pageNumPending = null;
let currentRenderTask = null;

// Cache LRU de páginas já renderizadas (ImageBitmap)
const RENDER_CACHE_SIZE = 6;
const renderCache = new Map(); // key = `${pageNum}:${scale}` → ImageBitmap

// Cache de PDFPageProxy (páginas já buscadas do arquivo)
const pageProxyCache = new Map();

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

function getPageProxy(num) {
    if (pageProxyCache.has(num)) {
        return Promise.resolve(pageProxyCache.get(num));
    }
    return pdfDoc.getPage(num).then(function (page) {
        pageProxyCache.set(num, page);
        return page;
    });
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

    const key = cacheKey(num, currentScale);

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
        // Atualiza LRU movendo para o fim
        renderCache.delete(key);
        renderCache.set(key, bitmap);
        schedulePrefetch(num);
        return;
    }

    if (!isPrefetch) {
        rendering = true;
        // Cancela render anterior se estiver em progresso
        if (currentRenderTask) {
            try { currentRenderTask.cancel(); } catch (e) {}
        }
    }

    try {
        const page = await getPageProxy(num);
        const viewport = page.getViewport({ scale: currentScale * DPR });

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
    if (renderCache.has(key)) return;

    // Usa requestIdleCallback se disponível, senão setTimeout
    const schedule = window.requestIdleCallback || function (cb) { return setTimeout(cb, 100); };
    schedule(function () {
        renderPage(next, true);
    });
}

function queueRenderPage(num) {
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
    getPageProxy(currentPage).then(function (page) {
        const container = document.getElementById('canvas-container');
        const containerWidth = container.clientWidth - 32;
        const naturalViewport = page.getViewport({ scale: 1 });
        currentScale = containerWidth / naturalViewport.width;
        invalidateCacheOnScaleChange();
        queueRenderPage(currentPage);
    });
}

// Load PDF (com range requests + streaming habilitados por padrão)
const loadingTask = pdfjsLib.getDocument({
    url: pdfUrl,
    disableStream: false,
    disableAutoFetch: true,  // evita baixar tudo antecipadamente
    rangeChunkSize: 262144   // 256 KB por chunk
});

loadingTask.promise.then(function (pdf) {
    pdfDoc = pdf;
    totalSpan.textContent = pdf.numPages;
    pageInput.max = pdf.numPages;
    loadingMsg.remove();
    renderPage(1);
}).catch(function (err) {
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
    currentScale = Math.min(4.0, currentScale + 0.25);
    invalidateCacheOnScaleChange();
    queueRenderPage(currentPage);
});

btnZoomOut.addEventListener('click', function () {
    currentScale = Math.max(0.25, currentScale - 0.25);
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
