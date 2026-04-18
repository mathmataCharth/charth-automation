'use strict';

const bcrypt = require('bcryptjs');

async function hashPassword(password) {
    return bcrypt.hash(password, 12);
}

async function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}

module.exports = { hashPassword, comparePassword };
