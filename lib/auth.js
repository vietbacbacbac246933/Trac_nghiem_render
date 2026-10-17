'use strict';
/**
 * lib/auth.js
 * ---------------------------------------------------------------------------
 * Xac thuc giao vien bang mat khau (bien moi truong TEACHER_PASSWORD).
 *
 * - Mat khau KHONG bao gio gui xuong frontend.
 * - Sau khi dang nhap, server cap 1 cookie phien da ky HMAC (stateless),
 *   httpOnly + SameSite=Strict. Khong can luu session o server -> chay duoc
 *   voi nhieu instance.
 * - Neu chua cau hinh TEACHER_PASSWORD, che do xac thuc tat; khi do chi cho
 *   phep truy cap tu localhost (giu hanh vi cu khi chay local cho tien).
 */

var crypto = require('crypto');

var COOKIE_NAME = 'quiz_teacher';
var TTL_MS = 12 * 60 * 60 * 1000; // 12 gio
var SESSION_SECRET = process.env.SESSION_SECRET || '';
var TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '';

if (!SESSION_SECRET) {
    // Fallback: dan xuat tu mat khau de khong bat buoc phai cau hinh them.
    // Khuyen nghi dat SESSION_SECRET rieng tren Render.
    SESSION_SECRET = TEACHER_PASSWORD
        ? crypto.createHash('sha256').update('quiz-session|' + TEACHER_PASSWORD).digest('hex')
        : crypto.randomBytes(32).toString('hex');
    if (TEACHER_PASSWORD && !process.env.SESSION_SECRET) {
        console.warn('[AUTH] Chua dat SESSION_SECRET, dang dung gia tri dan xuat tu TEACHER_PASSWORD.');
    }
}

var MAX_ATTEMPTS = 8;
var WINDOW_MS = 10 * 60 * 1000;
var attempts = {}; // ip -> { count, first }

// ---------------------------------------------------------------------------
function base64urlEncode(str) {
    return Buffer.from(str, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}

function hmac(data) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqualStr(a, b) {
    var ha = crypto.createHash('sha256').update(String(a)).digest();
    var hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
    var out = {};
    if (!header) return out;
    header.split(';').forEach(function (part) {
        var idx = part.indexOf('=');
        if (idx === -1) return;
        var k = part.slice(0, idx).trim();
        var v = part.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    });
    return out;
}

// ---------------------------------------------------------------------------
var auth = {
    COOKIE_NAME: COOKIE_NAME,
    enabled: !!TEACHER_PASSWORD,

    init: function () {
        if (this.enabled) {
            console.log('[AUTH] Da bat xac thuc giao vien (TEACHER_PASSWORD).');
        } else {
            console.warn('[AUTH] CHUA dat TEACHER_PASSWORD -> trang giao vien chi truy cap duoc tu localhost.');
            console.warn('[AUTH] Tren Render hay dat bien moi truong TEACHER_PASSWORD de dang nhap.');
        }
    },

    checkPassword: function (password) {
        if (!this.enabled) return false;
        return timingSafeEqualStr(password || '', TEACHER_PASSWORD);
    },

    issueToken: function () {
        var payload = JSON.stringify({ r: 'teacher', exp: Date.now() + TTL_MS });
        var data = base64urlEncode(payload);
        return data + '.' + hmac(data);
    },

    verifyToken: function (token) {
        if (!token || token.indexOf('.') === -1) return false;
        var parts = token.split('.');
        if (parts.length !== 2) return false;
        var data = parts[0], sig = parts[1];
        if (!timingSafeEqualStr(sig, hmac(data))) return false;
        try {
            var payload = JSON.parse(base64urlDecode(data));
            return payload && payload.r === 'teacher' && payload.exp > Date.now();
        } catch (e) {
            return false;
        }
    },

    // Danh cho route/protected API
    isAuthenticated: function (req) {
        if (!this.enabled) return isLocalhostRequest(req);
        var cookies = parseCookies(req.headers && req.headers.cookie);
        return this.verifyToken(cookies[COOKIE_NAME]);
    },

    setCookie: function (res, token, secure) {
        res.cookie(COOKIE_NAME, token, {
            httpOnly: true,
            sameSite: 'strict',
            secure: !!secure,
            maxAge: TTL_MS,
            path: '/'
        });
    },

    clearCookie: function (res) {
        res.cookie(COOKIE_NAME, '', { httpOnly: true, sameSite: 'strict', maxAge: 0, path: '/' });
    },

    // Chong brute-force don gian theo IP
    isBlocked: function (ip) {
        var rec = attempts[ip];
        if (!rec) return false;
        if (Date.now() - rec.first > WINDOW_MS) { delete attempts[ip]; return false; }
        return rec.count >= MAX_ATTEMPTS;
    },

    recordFailure: function (ip) {
        var rec = attempts[ip];
        if (!rec || Date.now() - rec.first > WINDOW_MS) {
            attempts[ip] = { count: 1, first: Date.now() };
        } else {
            rec.count++;
        }
    },

    clearFailures: function (ip) {
        delete attempts[ip];
    }
};

// Dung khi chua cau hinh TEACHER_PASSWORD (chi local)
function isLocalhostRequest(req) {
    var ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.indexOf('127.0.0.1') !== -1;
}

module.exports = auth;
