'use strict';

function adminAuth(req, res, next) {
    if (req.session && req.session.adminId) {
        return next();
    }
    return res.redirect('/admin/login');
}

module.exports = adminAuth;
