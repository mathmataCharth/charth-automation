'use strict';

const { formatVersionLabel } = require('./accessCode');

function versionLayout(width, height, code, font) {
    const label = formatVersionLabel(code);
    const margin = Math.min(14, width * 0.035, height * 0.035);
    const size = Math.min(8, height / 30, (width - 2 * margin) / font.widthOfTextAtSize(label, 1));
    const textWidth = font.widthOfTextAtSize(label, size);
    return { label, size, positions: [
        { x: (width - textWidth) / 2, y: height - Math.min(10, height * 0.025), angle: 0 },
        { x: width * 0.055, y: (height - textWidth) / 2, angle: 90 },
        { x: width - margin - textWidth, y: height * 0.125, angle: 0 }
    ] };
}

module.exports = { versionLayout };
