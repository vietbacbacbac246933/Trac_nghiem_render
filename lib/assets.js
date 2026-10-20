'use strict';
/**
 * lib/assets.js
 * ---------------------------------------------------------------------------
 * Dinh danh va URL cho anh tai len truc tiep trong trinh soan cau hoi.
 *
 * Anh duoc luu thanh nhi phan (khong base64 trong database):
 *   - PostgreSQL: bang quiz_assets (bytea)
 *   - Filesystem: data/uploads/<id>
 *
 * Id gom 32 ky tu hex + phan mo rong anh da kiem tra magic bytes. URL co the
 * doan truoc de sanitizer HTML cho phep, nhung khong the gia mao id khac.
 */

var crypto = require('crypto');

var MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp'
};

var EXT_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/webp': 'webp'
};

var ASSET_ID_RE = /^[a-f0-9]{32}\.(png|jpe?g|gif|bmp|webp)$/;

function newId(mime) {
    var ext = EXT_BY_MIME[String(mime || '').toLowerCase()];
    if (!ext) return null;
    return crypto.randomBytes(16).toString('hex') + '.' + ext;
}

function isAssetId(id) {
    return ASSET_ID_RE.test(String(id || ''));
}

function urlForId(id) {
    return '/api/assets/' + id;
}

function isAssetUrl(src) {
    var s = String(src || '');
    if (s.indexOf('/api/assets/') !== 0) return false;
    return isAssetId(s.slice('/api/assets/'.length));
}

function mimeForId(id) {
    if (!isAssetId(id)) return null;
    var ext = String(id).split('.').pop().toLowerCase();
    return MIME_BY_EXT[ext] || null;
}

module.exports = {
    newId: newId,
    isAssetId: isAssetId,
    urlForId: urlForId,
    isAssetUrl: isAssetUrl,
    mimeForId: mimeForId,
    EXT_BY_MIME: EXT_BY_MIME
};
