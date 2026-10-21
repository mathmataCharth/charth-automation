'use strict';

// Run from the application folder. Does not compress or overwrite existing PDFs.
require('dotenv').config();
const path = require('path');
const { prepareParts } = require('../src/services/pdfPartsService');

async function main() {
    const input = process.argv[2];
    const documents = input ? [{ stored_filename: path.resolve(input) }]
        : require('../src/config/database').prepare('SELECT stored_filename FROM documents').all();
    let failures = 0;
    for (const document of documents) {
        const file = path.resolve(process.env.UPLOAD_DIR || './uploads', document.stored_filename);
        try {
            const manifest = await prepareParts(file);
            console.log(`${path.basename(file)}: ${manifest.pageCount} páginas, ${manifest.parts.length} blocos.`);
        } catch (error) {
            failures++;
            console.error(`${path.basename(file)}: ${error.message}`);
        }
    }
    if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
