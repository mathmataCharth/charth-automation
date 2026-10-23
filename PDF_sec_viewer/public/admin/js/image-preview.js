'use strict';

(function () {
    const el = id => document.getElementById(id);
    const stage = el('preview');
    const prefix = stage.dataset.prefix;
    const mode = stage.dataset.mode;
    const image = el('page-image');
    const canvas = el('page-canvas');
    const message = el('message');
    const status = el('page-status');
    const images = new Map();
    const documents = new Map();
    let info, target = Number(stage.dataset.page) || 1, zoom = 0.75, revision = 0;
    let fitPage = false;
    let visibleUrl = '', visiblePage = 0, firstShown = false, renderTask = null, pdfLibrary = null;
    let prefetchTimer, resizeTimer, statusTimer;
    const now = () => performance.now();
    const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const seconds = value => (value / 1000).toFixed(2).replace('.', ',') + ' s';
    const bytes = value => value >= 1024 * 1024 ? (value / 1024 / 1024).toFixed(2).replace('.', ',') + ' MB' : Math.round(value / 1024) + ' KB';
    function availableSize() {
        const style = window.getComputedStyle(stage);
        return { width: Math.max(1, stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
            height: Math.max(1, stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) };
    }
    const fitWidth = () => availableSize().width;
    function fitZoom(width, height) {
        const available = availableSize();
        // Round down to the same 5% steps shown in the size selector.
        return Math.max(0.25, Math.floor(Math.min(1, available.height * width / height / available.width) * 20) / 20);
    }

    function loading(text) {
        clearTimeout(statusTimer);
        status.hidden = firstShown;
        message.hidden = false;
        message.classList.remove('is-error');
        message.textContent = text;
        el('retry').hidden = true;
        stage.setAttribute('aria-busy', 'true');
        // Cached/preloaded pages should switch without a flashing loading badge.
        if (firstShown) statusTimer = setTimeout(() => { status.hidden = false; }, 200);
    }

    function loaded() {
        clearTimeout(statusTimer);
        status.hidden = true;
        message.hidden = true;
        stage.setAttribute('aria-busy', 'false');
    }

    function failed(text) {
        clearTimeout(statusTimer);
        status.hidden = false;
        message.hidden = false;
        message.textContent = text;
        message.classList.add('is-error');
        el('retry').hidden = false;
        stage.setAttribute('aria-busy', 'false');
    }

    function controls() {
        el('page-number').value = target;
        el('page-number').max = info?.pageCount || 1;
        el('page-total').textContent = info?.pageCount || '…';
        el('previous').disabled = !info || target <= 1;
        el('next').disabled = !info || target >= info.pageCount;
        el('zoom-value').value = String(Math.round(zoom * 100));
        el('zoom-out').disabled = zoom <= 0.25;
        el('zoom-in').disabled = zoom >= 3;
        el('mode-images').href = prefix + '?page=' + target;
        el('mode-pdf').href = prefix + '?mode=pdf&page=' + target;
    }

    function pruneImages() {
        // Keep at most three blobs, including the visible one. Drop old detail
        // images before previews, so long sessions do not accumulate large files.
        for (const [key, entry] of images) {
            const page = Number(key.split(':')[0]);
            if (entry.url === visibleUrl || (images.size <= 3 && (entry.profile !== 'detail' || page === target))) continue;
            entry.controller.abort();
            if (entry.url) URL.revokeObjectURL(entry.url);
            images.delete(key);
        }
    }

    function getImage(page, profile) {
        const key = page + ':' + profile;
        if (images.has(key)) {
            const entry = images.get(key);
            images.delete(key);
            images.set(key, entry);
            return entry.promise.then(result => ({ ...result, memoryHit: true }));
        }
        const entry = { profile, controller: new AbortController() };
        entry.promise = (async () => {
            const response = await fetch(`${prefix}/images/${info.version}/${page}/${profile}`, {
                credentials: 'same-origin', cache: 'no-store', signal: entry.controller.signal
            });
            if (!response.ok) {
                const problem = await response.json().catch(() => ({}));
                throw new Error(problem.error || 'Imagem indisponível. Tente novamente.');
            }
            const blob = await response.blob();
            entry.url = URL.createObjectURL(blob);
            const decoded = new Image();
            decoded.src = entry.url;
            await decoded.decode();
            if (entry.controller.signal.aborted) throw new Error('Carregamento cancelado.');
            Object.assign(entry, { width: decoded.naturalWidth, height: decoded.naturalHeight, size: blob.size,
                cacheHit: response.headers.get('X-Preview-Cache') === 'HIT' || response.headers.get('X-Media-Delivery') === 'cloudflare',
                preparation: Number((response.headers.get('Server-Timing') || '').match(/prepare;dur=([\d.]+)/)?.[1] || 0) });
            return entry;
        })().catch(error => {
            if (images.get(key) === entry) images.delete(key);
            if (entry.url) URL.revokeObjectURL(entry.url);
            throw error;
        });
        images.set(key, entry);
        return entry.promise;
    }

    function loadPdfLibrary() {
        if (!pdfLibrary) pdfLibrary = new Promise((resolve, reject) => {
            if (window.pdfjsLib) return resolve(window.pdfjsLib);
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            script.onload = () => resolve(window.pdfjsLib);
            script.onerror = () => { pdfLibrary = null; reject(new Error('Não foi possível carregar o visualizador PDF.')); };
            document.head.appendChild(script);
        });
        return pdfLibrary;
    }

    async function pdfPage(page, token) {
        const pdfjs = await loadPdfLibrary();
        if (token !== revision) return null;
        pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const parts = info.parts || [{ start: 1, end: info.pageCount, url: info.url }];
        const index = parts.findIndex(part => page >= part.start && page <= part.end);
        if (index < 0) throw new Error('Página não encontrada.');
        let entry = documents.get(index);
        if (!entry) {
            const task = pdfjs.getDocument({ url: parts[index].url, disableStream: true, disableAutoFetch: true, rangeChunkSize: 262144 });
            entry = { task, promise: task.promise, users: 0 };
            documents.set(index, entry);
            task.promise.catch(() => { if (documents.get(index) === entry) documents.delete(index); });
        }
        documents.delete(index);
        documents.set(index, entry);
        entry.users++;
        try {
            const pdf = await entry.promise;
            if (!info.parts) { info.pageCount = pdf.numPages; parts[0].end = pdf.numPages; }
            if (token !== revision) return null;
            const source = await pdf.getPage(page - parts[index].start + 1);
            if (token !== revision) return null;
            const natural = source.getViewport({ scale: 1 });
            if (fitPage) zoom = fitZoom(natural.width, natural.height);
            let scale = fitWidth() * zoom * Math.min(window.devicePixelRatio || 1, 2) / natural.width;
            scale = Math.min(scale, Math.sqrt(16000000 / (natural.width * natural.height)));
            const viewport = source.getViewport({ scale });
            const offscreen = document.createElement('canvas');
            offscreen.width = Math.ceil(viewport.width);
            offscreen.height = Math.ceil(viewport.height);
            renderTask = source.render({ canvasContext: offscreen.getContext('2d', { alpha: false }), viewport });
            await renderTask.promise;
            return offscreen;
        } finally {
            entry.users--;
            for (const [oldIndex, old] of documents) {
                if (documents.size <= 3) break;
                if (old.users) continue;
                documents.delete(oldIndex);
                old.task.destroy().catch(() => {});
            }
        }
    }

    async function show(page, started = now()) {
        if (!info) return;
        target = Math.max(1, Math.min(info.pageCount, page));
        const token = ++revision;
        clearTimeout(prefetchTimer);
        if (renderTask) { try { renderTask.cancel(); } catch (_) {} }
        loading(zoom > 1.25 && mode === 'images' ? 'Carregando detalhes em alta resolução…' : 'Carregando página…');
        controls();
        try {
            if (mode === 'images') {
                const profile = zoom > 1.25 ? 'detail' : 'view';
                const entry = await getImage(target, profile);
                if (token !== revision) return;
                if (fitPage) zoom = fitZoom(entry.width, entry.height);
                visibleUrl = entry.url;
                image.width = entry.width;
                image.height = entry.height;
                image.src = entry.url;
                image.style.width = Math.round(fitWidth() * zoom) + 'px';
                image.alt = 'Página ' + target + ' do lookbook';
                image.hidden = false;
                canvas.hidden = true;
                el('asset-details').textContent = (profile === 'detail' ? 'Alta resolução' : 'Visualização') +
                    ' · ' + Math.max(entry.width, entry.height) + ' px · ' + bytes(entry.size);
                el('cache-details').textContent = entry.memoryHit ? 'Imagem já carregada nesta tela' :
                    entry.cacheHit ? 'Imagem pronta no servidor' : 'Preparação inicial no servidor: ' + seconds(entry.preparation);
                pruneImages();
            } else {
                const rendered = await pdfPage(target, token);
                if (!rendered || token !== revision) return;
                canvas.width = rendered.width;
                canvas.height = rendered.height;
                canvas.style.width = Math.round(fitWidth() * zoom) + 'px';
                canvas.getContext('2d', { alpha: false }).drawImage(rendered, 0, 0);
                canvas.hidden = false;
                image.hidden = true;
                el('asset-details').textContent = 'PDF · carregamento por blocos';
                el('cache-details').textContent = '';
            }
            // Publish the decoded page and its scroll position in the same frame.
            // Zoom/resize of the current page preserves the reader's position.
            if (visiblePage !== target) {
                stage.scrollTop = 0;
                stage.scrollLeft = 0;
            }
            visiblePage = target;
            loaded();
            await paint();
            if (token !== revision) return;
            const elapsed = seconds(now() - started);
            el('page-time').textContent = elapsed;
            if (!firstShown) { firstShown = true; el('first-time').textContent = seconds(now()); }
            controls();
            if (mode === 'images' && target < info.pageCount) {
                const nextPage = target + 1;
                prefetchTimer = setTimeout(() => {
                    if (token !== revision) return;
                    getImage(nextPage, 'view').then(pruneImages).catch(() => {});
                }, 700);
            }
        } catch (error) {
            if (token !== revision) return;
            failed(error.message || 'Não foi possível carregar a página.');
        }
    }

    async function start() {
        loading('Carregando página…');
        try {
            const response = await fetch(prefix + (mode === 'pdf' ? '/pdf/info' : '/info'), { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) throw new Error(response.status === 401 ? 'Sua sessão terminou. Abra novamente o link de acesso.' : 'Documento indisponível.');
            info = await response.json();
            await show(target, 0);
        } catch (error) {
            failed(error.message || 'Não foi possível carregar o documento.');
        }
    }

    el('previous').addEventListener('click', () => show(target - 1));
    el('next').addEventListener('click', () => show(target + 1));
    el('page-number').addEventListener('change', () => {
        const page = Number(el('page-number').value);
        if (Number.isSafeInteger(page)) show(page); else controls();
    });
    el('page-number').addEventListener('keydown', event => { if (event.key === 'Enter') el('page-number').blur(); });
    function setZoom(percent) {
        if (!Number.isFinite(percent)) return;
        zoom = Math.max(25, Math.min(300, Math.round(percent / 5) * 5)) / 100;
        fitPage = false;
        show(target);
    }
    el('zoom-in').addEventListener('click', () => setZoom(Math.round(zoom * 100) + 5));
    el('zoom-out').addEventListener('click', () => setZoom(Math.round(zoom * 100) - 5));
    el('zoom-value').addEventListener('change', () => setZoom(Number(el('zoom-value').value)));
    el('fit').addEventListener('click', () => { fitPage = true; show(target); });
    el('repeat').addEventListener('click', () => { window.location.href = prefix + '?mode=' + mode + '&page=' + target; });
    el('retry').addEventListener('click', () => { if (info) show(target); else start(); });
    document.addEventListener('contextmenu', event => event.preventDefault());
    document.addEventListener('dragstart', event => event.preventDefault());
    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && ['p', 's'].includes(event.key.toLowerCase())) event.preventDefault();
        if (event.target.tagName === 'INPUT') return;
        if (event.key === 'ArrowRight' && info && target < info.pageCount) { event.preventDefault(); show(target + 1); }
        if (event.key === 'ArrowLeft' && target > 1) { event.preventDefault(); show(target - 1); }
    });
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => show(target), 200); });
    window.addEventListener('pagehide', () => {
        revision++;
        clearTimeout(prefetchTimer);
        clearTimeout(resizeTimer);
        clearTimeout(statusTimer);
        for (const entry of images.values()) { entry.controller.abort(); if (entry.url) URL.revokeObjectURL(entry.url); }
        for (const entry of documents.values()) entry.task.destroy().catch(() => {});
    });
    window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
    start();
})();
