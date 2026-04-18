'use strict';

function viewerAuth(req, res, next) {
    const token = req.params.token;
    if (
        req.session &&
        req.session.viewerTokens &&
        req.session.viewerTokens[token] === true
    ) {
        return next();
    }
    return res.redirect(`/v/${token}`);
}

module.exports = viewerAuth;
