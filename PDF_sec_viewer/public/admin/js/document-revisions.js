'use strict';
(() => {
    const panel = document.querySelector('[data-revision-status]');
    if (!panel) return;
    const rows = new Map([...panel.querySelectorAll('[data-revision-id]')].map(row => [Number(row.dataset.revisionId), row]));
    const labels = { queued: 'Na fila', validating: 'Validando PDF', preparing: 'Preparando imagens', active: 'Em uso',
        archived: 'Versão anterior', failed: 'Preparação interrompida', cancelled: 'Cancelada' };
    let stopped = false, timer;
    async function update() {
        try {
            const response = await fetch(panel.dataset.revisionStatus, { credentials: 'same-origin', cache: 'no-store' });
            if (response.redirected || !response.ok) { stopped = true; return; }
            const { revisions } = await response.json();
            for (const revision of revisions) {
                const row = rows.get(revision.id);
                if (!row || row.dataset.revisionState !== revision.status && ['preparing','active','archived','failed','cancelled'].includes(revision.status)) {
                    window.location.reload(); return;
                }
                row.querySelector('.revision-state').textContent = labels[revision.status] || revision.status;
                row.querySelector('.revision-progress').textContent = revision.status === 'preparing' && revision.total ?
                    ' · ' + Math.floor(revision.completed / revision.total * 100) + '%' : '';
            }
        } catch (_) { /* The current PDF and manual controls remain available. */ }
        if (!stopped) timer = setTimeout(update, 5000);
    }
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
    update();
})();
