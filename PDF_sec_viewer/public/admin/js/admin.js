'use strict';

(function () {
    document.querySelectorAll('.edit-link-btn, .cancel-edit-link').forEach(function (button) {
        button.addEventListener('click', function () {
            const row = document.getElementById(button.dataset.target);
            if (!row) return;
            const opening = button.classList.contains('edit-link-btn') && row.hidden;
            row.hidden = !opening;
            const trigger = document.querySelector('.edit-link-btn[aria-controls="' + row.id + '"]');
            if (trigger) trigger.setAttribute('aria-expanded', String(opening));
            if (opening) row.querySelector('input').focus();
            else {
                row.querySelector('form').reset();
                if (trigger) trigger.focus();
            }
        });
    });

    // Copy link buttons
    document.querySelectorAll('.copy-link-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            const url = btn.getAttribute('data-url');
            if (!url) return;

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(function () {
                    showToast('Link copiado!');
                }).catch(function () {
                    fallbackCopy(url);
                });
            } else {
                fallbackCopy(url);
            }
        });
    });

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
            document.execCommand('copy');
            showToast('Link copiado!');
        } catch (e) {
            showToast('Erro ao copiar link.');
        }
        document.body.removeChild(ta);
    }

    function showToast(msg) {
        let toast = document.getElementById('toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'toast';
            toast.className = 'toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.remove('hidden');
        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(function () {
            toast.classList.add('hidden');
        }, 2200);
    }

    // Confirm delete forms
    document.querySelectorAll('.confirm-delete').forEach(function (form) {
        form.addEventListener('submit', function (e) {
            const msg = form.getAttribute('data-message') || 'Confirmar exclusão?';
            if (!confirm(msg)) {
                e.preventDefault();
            }
        });
    });
})();
