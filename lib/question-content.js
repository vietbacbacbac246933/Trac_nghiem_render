'use strict';
/**
 * lib/question-content.js
 * ---------------------------------------------------------------------------
 * Quy tac dung chung cho noi dung cau hoi:
 *   - normalizePoints / parsePointsInput: diem tung cau
 *   - scoreQuestion: cham 1 cau, tra ve 0..1 (khong nhan diem cua cau)
 *   - sanitizeHtml: loc HTML cau hoi/dap an, cho phep anh data URI cu va
 *     anh tai len moi qua /api/assets/<id>
 *
 * Tach khoi server.js de test duoc ma khong can khoi dong server.
 */

var grading = require('./grading');
var assets = require('./assets');

// Diem va cham diem nam trong ./grading de chi co mot nguon su that.
var normalizePoints = grading.normalizePoints;
var scoreQuestion = grading.scoreQuestion;

// Gia tri giao vien nhap: tra null neu khong hop le (am, 0, NaN, > 100).
function parsePointsInput(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (!s) return null;
    var n = Number(s);
    if (!isFinite(n) || n <= 0 || n > 100) return null;
    return Math.round(n * 100) / 100;
}

// ========== HTML SANITIZER (server-side, regex-based) ==========
var ALLOWED_HTML_TAGS = {
    'b': [], 'strong': [], 'i': [], 'em': [], 'u': [],
    'p': [], 'div': [], 'br': [], 'span': ['style'], 'sub': [], 'sup': [],
    'img': ['src', 'alt', 'width', 'height', 'style'],
    'pre': [], 'code': []
};

function sanitizeStyleAttr(style) {
    if (/url\s*\(|expression\s*\(|javascript:/i.test(style)) return '';
    var safeParts = [];
    var declarations = style.split(';');
    var SAFE_PROPS = ['color','background-color','font-size','font-weight','font-style',
                      'text-decoration','vertical-align','width','height','max-width','max-height'];
    for (var i = 0; i < declarations.length; i++) {
        var parts = declarations[i].split(':');
        if (parts.length >= 2) {
            var prop = parts[0].trim().toLowerCase();
            var val = parts.slice(1).join(':').trim();
            if (SAFE_PROPS.indexOf(prop) >= 0 && !/url|expression|javascript/i.test(val)) {
                safeParts.push(prop + ':' + val);
            }
        }
    }
    return safeParts.join(';');
}

function sanitizeHtml(html) {
    if (!html || typeof html !== 'string') return '';
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/gi, function(fullMatch, tagName, attrs) {
        var lowerTag = tagName.toLowerCase();
        if (fullMatch.charAt(1) === '/') {
            return ALLOWED_HTML_TAGS.hasOwnProperty(lowerTag) ? '</' + lowerTag + '>' : '';
        }
        if (!ALLOWED_HTML_TAGS.hasOwnProperty(lowerTag)) return '';
        var allowedAttrs = ALLOWED_HTML_TAGS[lowerTag];
        var cleanAttrs = '';
        for (var i = 0; i < allowedAttrs.length; i++) {
            var attrName = allowedAttrs[i];
            var attrRegex = new RegExp(attrName + '\\s*=\\s*("([^"]*)"' + "|'([^']*)'|(\\S+))", 'i');
            var attrMatch = attrs.match(attrRegex);
            if (attrMatch) {
                var attrVal = attrMatch[2] !== undefined ? attrMatch[2] : (attrMatch[3] !== undefined ? attrMatch[3] : (attrMatch[4] || ''));
                if (attrName === 'src') {
                    // Anh cu tu Word (data URI) va anh tai len moi (/api/assets/<id>).
                    if (attrVal.indexOf('data:image/') !== 0 && !assets.isAssetUrl(attrVal)) continue;
                }
                if (attrName === 'style') {
                    attrVal = sanitizeStyleAttr(attrVal);
                    if (!attrVal) continue;
                }
                cleanAttrs += ' ' + attrName + '="' + attrVal + '"';
            }
        }
        var selfClose = (lowerTag === 'br' || lowerTag === 'img') ? ' /' : '';
        return '<' + lowerTag + cleanAttrs + selfClose + '>';
    });
    return html.trim();
}

module.exports = {
    normalizePoints: normalizePoints,
    parsePointsInput: parsePointsInput,
    scoreQuestion: scoreQuestion,
    sanitizeHtml: sanitizeHtml,
    sanitizeStyleAttr: sanitizeStyleAttr,
    ALLOWED_HTML_TAGS: ALLOWED_HTML_TAGS
};
