'use strict';
const crypto = require('crypto');
function documentVersion(doc) {
    return crypto.createHash('sha256').update(doc.stored_filename).digest('hex');
}
module.exports = { documentVersion };
