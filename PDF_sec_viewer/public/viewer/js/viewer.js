'use strict';

// === Security: Block keyboard shortcuts ===
document.addEventListener('keydown', function (e) {
    const key = e.key || e.keyCode;
    const ctrl = e.ctrlKey || e.metaKey;

    // Block Ctrl+P (print)
    if (ctrl && (key === 'p' || key === 'P' || e.keyCode === 80)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
    }

    // Block Ctrl+S (save)
    if (ctrl && (key === 's' || key === 'S' || e.keyCode === 83)) {
        e.preventDefault();
        return false;
    }

    // Block Ctrl+Shift+I (DevTools)
    if (ctrl && e.shiftKey && (key === 'i' || key === 'I' || e.keyCode === 73)) {
        e.preventDefault();
        return false;
    }

    // Block Ctrl+Shift+J (Console)
    if (ctrl && e.shiftKey && (key === 'j' || key === 'J' || e.keyCode === 74)) {
        e.preventDefault();
        return false;
    }

    // Block Ctrl+U (view source)
    if (ctrl && (key === 'u' || key === 'U' || e.keyCode === 85)) {
        e.preventDefault();
        return false;
    }

    // Block F12 (DevTools)
    if (key === 'F12' || e.keyCode === 123) {
        e.preventDefault();
        return false;
    }

    // Block PrintScreen
    if (key === 'PrintScreen' || e.keyCode === 44) {
        e.preventDefault();
        return false;
    }

    // Block Ctrl+A (select all)
    if (ctrl && (key === 'a' || key === 'A' || e.keyCode === 65)) {
        e.preventDefault();
        return false;
    }

    // Block Ctrl+C (copy)
    if (ctrl && (key === 'c' || key === 'C' || e.keyCode === 67)) {
        e.preventDefault();
        return false;
    }
}, true);

// === Security: Block right-click ===
document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    return false;
}, true);

// === Security: Block drag ===
document.addEventListener('dragstart', function (e) {
    e.preventDefault();
    return false;
}, true);

document.addEventListener('drop', function (e) {
    e.preventDefault();
    return false;
}, true);

// === Security: Block text selection ===
document.addEventListener('selectstart', function (e) {
    e.preventDefault();
    return false;
}, true);

// === PDF Viewer State ===
const canvas = document.getElementById('pdf-canvas');
const pdfUrl = canvas.dataset.url;
const totalPagesFromAttr = parseInt(canvas.dataset.pages, 10) || 1;

const ctx = canvas.getContext('2d');

let pdfDoc = null;
let currentPage = 1;
let currentScale = 1.5;
let rendering = false;
let pageNumPending = null;

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

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

function renderPage(num) {
    if (!pdfDoc) return;
    rendering = true;

    pdfDoc.getPage(num).then(function (page) {
        const viewport = page.getViewport({ scale: currentScale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderCtx = {
            canvasContext: ctx,
            viewport: viewport
        };

        const renderTask = page.render(renderCtx);
        renderTask.promise.then(function () {
            rendering = false;
            if (pageNumPending !== null) {
                const p = pageNumPending;
                pageNumPending = null;
                renderPage(p);
            }
        });
    });

    currentPage = num;
    updateToolbar();
}

function queueRenderPage(num) {
    if (rendering) {
        pageNumPending = num;
    } else {
        renderPage(num);
    }
}

function fitToWindow() {
    if (!pdfDoc) return;
    pdfDoc.getPage(currentPage).then(function (page) {
        const container = document.getElementById('canvas-container');
        const containerWidth = container.clientWidth - 32; // padding
        const naturalViewport = page.getViewport({ scale: 1 });
        currentScale = containerWidth / naturalViewport.width;
        queueRenderPage(currentPage);
    });
}

// Load PDF
pdfjsLib.getDocument(pdfUrl).promise.then(function (pdf) {
    pdfDoc = pdf;
    totalSpan.textContent = pdf.numPages;
    pageInput.max = pdf.numPages;
    loadingMsg.remove();
    renderPage(1);
}).catch(function (err) {
    loadingMsg.textContent = 'Erro ao carregar o documento. Tente recarregar a página.';
    console.error('PDF load error:', err);
});

// Toolbar: Previous page
btnPrev.addEventListener('click', function () {
    if (currentPage <= 1) return;
    queueRenderPage(currentPage - 1);
});

// Toolbar: Next page
btnNext.addEventListener('click', function () {
    if (!pdfDoc || currentPage >= pdfDoc.numPages) return;
    queueRenderPage(currentPage + 1);
});

// Toolbar: Go to page (input)
pageInput.addEventListener('change', function () {
    if (!pdfDoc) return;
    const num = parseInt(pageInput.value, 10);
    if (isNaN(num)) return;
    const clamped = Math.max(1, Math.min(pdfDoc.numPages, num));
    queueRenderPage(clamped);
});

pageInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        pageInput.dispatchEvent(new Event('change'));
    }
});

// Toolbar: Zoom in
btnZoomIn.addEventListener('click', function () {
    currentScale = Math.min(4.0, currentScale + 0.25);
    queueRenderPage(currentPage);
});

// Toolbar: Zoom out
btnZoomOut.addEventListener('click', function () {
    currentScale = Math.max(0.25, currentScale - 0.25);
    queueRenderPage(currentPage);
});

// Toolbar: Fit to window
btnZoomFit.addEventListener('click', function () {
    fitToWindow();
});

// Keyboard navigation (arrow keys, page up/down)
document.addEventListener('keydown', function (e) {
    if (!pdfDoc) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        if (currentPage < pdfDoc.numPages) queueRenderPage(currentPage + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (currentPage > 1) queueRenderPage(currentPage - 1);
    }
});
