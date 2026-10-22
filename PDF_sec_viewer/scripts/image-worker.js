'use strict';
require('dotenv').config();
const os = require('os');
const { reconcile, runNext } = require('../src/services/imagePreparationService');
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
process.on('disconnect', () => { stopping = true; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
    let nextScan = 0;
    while (!stopping) {
        try {
            if (Date.now() >= nextScan) { await reconcile(); nextScan = Date.now() + 60000; }
            const worked = await runNext();
            await delay(worked ? 100 : 2000);
        } catch (error) { console.error('[IMAGE WORKER]', error.code || 'error'); await delay(5000); }
    }
    require('../src/config/database').close();
}
main().catch(() => { process.exitCode = 1; });
