'use strict';
(() => {
    const panel = document.querySelector('[data-image-status]');
    if (!panel) return;
    let stopped = false, timer;
    function label(job) {
        if (!job) return 'Aguardando preparação';
        if (job.status === 'ready') return 'Imagens prontas';
        if (job.status === 'paused') return 'Aguardando reativação';
        if (job.status === 'failed') return 'Preparação interrompida';
        return 'Preparando: ' + Math.floor(job.completed / job.total * 100) + '%';
    }
    async function update() {
        try {
            const response = await fetch(panel.dataset.imageStatus, { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) { if (response.status === 401 || response.redirected) stopped = true; throw new Error(); }
            const { jobs } = await response.json();
            const bases = jobs.find(job => job.linkId === null);
            const accesses = jobs.filter(job => job.linkId !== null);
            const ready = accesses.filter(job => job.status === 'ready').length;
            document.getElementById('image-preparation-summary').textContent = label(bases) + ' · Acessos prontos: ' + ready + '/' + accesses.length;
            for (const element of document.querySelectorAll('.image-link-status')) {
                element.textContent = label(accesses.find(job => job.linkId === Number(element.dataset.linkId)));
            }
        } catch (_) { document.getElementById('image-preparation-summary').textContent = 'Não foi possível consultar o progresso. Atualize a página.'; }
        if (!stopped) timer = setTimeout(update, 10000);
    }
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
    update();
})();
