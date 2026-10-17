'use strict';
/**
 * lib/ocr.js
 * ---------------------------------------------------------------------------
 * Trích xuất chữ từ ảnh (OCR), ưu tiên tiếng Việt.
 *
 * Nhà cung cấp:
 *   1. tesseract  - tesseract.js (WASM) chạy ngay trong process Node.
 *                   Mien phi, KHONG can API key, khong can apt/Docker
 *                   -> chay duoc tren Render native runtime.
 *   2. ocrspace   - OCR.space qua HTTP (can OCR_SPACE_API_KEY). Chat luong
 *                   tot hon voi anh chup dien thoai; co han muc mien phi.
 *
 * Chon nha cung cap:  tham so  ->  bien moi truong OCR_PROVIDER  ->  tu dong
 * (co OCR_SPACE_API_KEY thi dung ocrspace, nguoc lai dung tesseract).
 *
 * Nguyen tac:
 *   - CHI nhan Buffer trong RAM, KHONG ghi file upload ra dia.
 *   - KHONG chua khoa API trong ma nguon (chi doc tu process.env).
 *   - Dung 1 worker tesseract dung chung, xep hang tuan tu -> gioi han RAM.
 *
 * Bien moi truong:
 *   OCR_PROVIDER        auto | tesseract | ocrspace   (mac dinh auto)
 *   OCR_LANGS           "vie,eng" hoac "vie+eng"      (mac dinh vie+eng)
 *   OCR_SPACE_API_KEY   khoa OCR.space (khong bat buoc)
 *   OCR_SPACE_ENDPOINT  ghi de URL (dung cho test)
 *   OCR_DEBUG           "1" de in log tien trinh
 */

var path = require('path');
var fs = require('fs');

var DEFAULT_LANGS = ['vie', 'eng'];
var OCRSPACE_URL = 'https://api.ocr.space/parse/image';

var state = {
    worker: null,
    workerPromise: null,
    ready: false,
    langKey: null,
    lastError: null,
    queue: Promise.resolve()
};

function log() {
    if (process.env.OCR_DEBUG === '1') {
        console.log.apply(console, ['[OCR]'].concat(Array.prototype.slice.call(arguments)));
    }
}

function getLangs() {
    var raw = process.env.OCR_LANGS;
    if (!raw) return DEFAULT_LANGS.slice();
    var parts = String(raw).split(/[,+]/).map(function (s) { return s.trim(); }).filter(Boolean);
    return parts.length ? parts : DEFAULT_LANGS.slice();
}

function resolveProvider(explicit) {
    var p = (explicit || process.env.OCR_PROVIDER || 'auto').toLowerCase();
    if (p === 'tesseract' || p === 'ocrspace') return p;
    // auto
    return process.env.OCR_SPACE_API_KEY ? 'ocrspace' : 'tesseract';
}

// Thu muc cache traineddata cua tesseract.js.
// Day chi la cache du lieu ngon ngu CONG KHAI (khong phai file nguoi dung tai len),
// va nam trong vung duoc gitignore.
function cachePath() {
    var dir = path.join(__dirname, '..', 'data', 'ocr-cache');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    return dir;
}

function getWorker() {
    var langs = getLangs();
    var langKey = langs.join('+');

    // Doi ngon ngu -> huy worker cu
    if (state.workerPromise && state.langKey !== langKey) {
        var old = state.worker;
        state.worker = null;
        state.workerPromise = null;
        state.ready = false;
        if (old && typeof old.terminate === 'function') { old.terminate().catch(function () {}); }
    }
    if (state.workerPromise) return state.workerPromise;

    state.langKey = langKey;
    state.workerPromise = (async function () {
        var tesseract = require('tesseract.js');
        log('dang tao worker, ngon ngu =', langKey);
        var worker = await tesseract.createWorker(langs, 1, {
            cachePath: cachePath(),
            logger: function (m) {
                if (process.env.OCR_DEBUG === '1' && m && m.status) {
                    log('  ' + m.status + (m.progress ? ' ' + Math.round(m.progress * 100) + '%' : ''));
                }
            }
        });
        state.worker = worker;
        state.ready = true;
        log('worker san sang');
        return worker;
    })().catch(function (err) {
        state.lastError = (err && err.message) || String(err);
        state.workerPromise = null;
        state.ready = false;
        throw err;
    });

    return state.workerPromise;
}

// Xep hang: tesseract chi chay 1 anh mot thoi diem de gioi han RAM.
function enqueue(fn) {
    var run = state.queue.then(fn, fn);
    state.queue = run.then(function () {}, function () {});
    return run;
}

async function recognizeWithTesseract(buffer) {
    var worker = await getWorker();
    return enqueue(async function () {
        var res = await worker.recognize(buffer);
        var data = (res && res.data) || {};
        return {
            provider: 'tesseract',
            text: data.text || '',
            confidence: typeof data.confidence === 'number' ? data.confidence : null
        };
    });
}

async function recognizeWithOcrSpace(buffer, mime) {
    var key = process.env.OCR_SPACE_API_KEY;
    if (!key) throw new Error('Chưa cấu hình OCR_SPACE_API_KEY.');

    var ep = process.env.OCR_SPACE_ENDPOINT || OCRSPACE_URL;
    var lang = getLangs().indexOf('vie') >= 0 ? 'vie' : 'eng';

    var fd = new FormData();
    fd.append('apikey', key);
    fd.append('language', lang);
    fd.append('isOverlayRequired', 'false');
    fd.append('detectOrientation', 'true');
    fd.append('scale', 'true');
    fd.append('OCREngine', '2');
    fd.append('file', new Blob([buffer], { type: mime || 'image/png' }), 'image.png');

    var res = await fetch(ep, { method: 'POST', body: fd });
    var json = null;
    try { json = await res.json(); } catch (e) { json = null; }

    if (!res.ok || !json) {
        throw new Error('OCR.space trả lỗi HTTP ' + res.status + '.');
    }
    if (json.IsErroredOnProcessing) {
        var msg = Array.isArray(json.ErrorMessage) ? json.ErrorMessage.join(' ') : String(json.ErrorMessage || '');
        throw new Error('OCR.space: ' + (msg || 'không xử lý được ảnh'));
    }
    var text = (json.ParsedResults || []).map(function (r) { return r.ParsedText || ''; }).join('\n');
    return { provider: 'ocrspace', text: text, confidence: null };
}

/**
 * Nhan dien 1 anh tu Buffer.
 * @param {Buffer} buffer
 * @param {string} mime
 * @param {object} [opts] { provider }
 * @returns {Promise<{provider:string,text:string,confidence:number|null}>}
 */
async function recognize(buffer, mime, opts) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('Ảnh rỗng hoặc không đọc được.');
    }
    var provider = resolveProvider(opts && opts.provider);
    if (provider === 'ocrspace') return recognizeWithOcrSpace(buffer, mime);
    return recognizeWithTesseract(buffer);
}

// Khoi dong truoc (goi luc boot) de giao vien khong phai cho o request dau tien.
function warmUp() {
    var provider = resolveProvider();
    if (provider !== 'tesseract') {
        log('warmUp bo qua (provider =', provider + ')');
        return Promise.resolve(false);
    }
    return getWorker().then(function () { return true; }).catch(function (err) {
        log('warmUp that bai:', (err && err.message) || err);
        return false;
    });
}

async function terminate() {
    var w = state.worker;
    state.worker = null;
    state.workerPromise = null;
    state.ready = false;
    if (w && typeof w.terminate === 'function') {
        try { await w.terminate(); } catch (e) { /* ignore */ }
    }
}

function status() {
    return {
        provider: resolveProvider(),
        ready: state.ready,
        langs: getLangs(),
        error: state.lastError,
        keyConfigured: !!process.env.OCR_SPACE_API_KEY
    };
}

module.exports = {
    recognize: recognize,
    warmUp: warmUp,
    terminate: terminate,
    status: status,
    getLangs: getLangs,
    resolveProvider: resolveProvider
};
