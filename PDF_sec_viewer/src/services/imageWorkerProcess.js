'use strict';
const { fork } = require('child_process');
const path = require('path');
function startImageWorker() {
    if (process.env.IMAGE_PREPARATION_ENABLED === 'false') return;
    let child, timer, stopping = false;
    function start() {
        if (stopping) return;
        child = fork(path.resolve(__dirname, '../../scripts/image-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.once('exit', () => { if (!stopping) timer = setTimeout(start, 5000); });
        child.on('error', error => console.error('[IMAGE WORKER]', error.code || 'error'));
    }
    start();
    const stop = () => { stopping = true; clearTimeout(timer); if (child?.connected) child.disconnect(); };
    process.once('exit', stop);
    process.once('SIGTERM', () => { stop(); process.exit(0); });
    process.once('SIGINT', () => { stop(); process.exit(0); });
    return stop;
}
module.exports = { startImageWorker };
