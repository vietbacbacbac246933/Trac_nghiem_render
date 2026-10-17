'use strict';
/**
 * lib/underline.js
 * ---------------------------------------------------------------------------
 * Phat hien dap an dung duoc GACH CHAN trong anh de thi.
 *
 * Vi sao can: nhieu de thi (nhat la de in tu Word) danh dau dap an dung bang
 * cach gach chan chu cai dap an (vi du "D.") chu khong dung dau "*".
 * OCR thong thuong chi tra ve CHU, lam mat het thong tin gach chan.
 *
 * Cach lam (khong can thu vien OCR nao them):
 *   1. Giai ma anh -> do xam (pngjs cho PNG, jpeg-js cho JPEG).
 *   2. Nhi phan bang thuat toan Otsu; tu doan dau la "muc" (chu) dua tren
 *      viec lop nao chiem it diem anh hon -> dung cho ca anh nen sang va nen toi.
 *   3. Voi tung dong chu OCR da nhan dien duoc toa do (bbox + baseline), tim
 *      cac "doan muc lien tuc" nam NGAY DUOI duong baseline, keo dai xuong sat
 *      dong chu ke tiep (gach chan co the sat chan chu khi in tu Word, hoac thap
 *      hon khi anh do phan mem khac ve ra / anh chup bi lech). Gach chan la mot
 *      doan DAI va MANH (1-3 hang anh); net chu va duoi chu (g, y, ạ...) chi tao
 *      cac doan NGAN (~1/3 chieu cao dong) => nguong do dai moi la yeu to loc chinh.
 *
 * Nguyen tac: CHI doc Buffer trong RAM, khong ghi file, khong goi mang.
 * Neu khong giai ma duoc anh -> tra ve "khong co gach chan" (an toan, khong
 * bao gio tu ket luan sai lam).
 */

var MIN_RUN_RATIO = 0.55;   // do dai toi thieu cua gach chan so voi chieu cao dong
var MIN_RUN_PX = 16;        // chan duoi tuyet doi (px) de tranh nhet chu
var X_PAD = 3;              // noi rong vung tim theo chieu ngang
var DEBUG = !!process.env.OCR_DEBUG;

// ---------------------------------------------------------------------------
// Giai ma anh -> do xam
// ---------------------------------------------------------------------------

function decodeGray(buffer, mime) {
    var m = String(mime || '').toLowerCase();
    try {
        if (m.indexOf('png') >= 0 || isPng(buffer)) {
            var PNG = require('pngjs').PNG;
            var png = PNG.sync.read(buffer);
            return { width: png.width, height: png.height, rgba: png.data };
        }
        if (m.indexOf('jpe') >= 0 || m.indexOf('jpg') >= 0 || isJpeg(buffer)) {
            var jpeg = require('jpeg-js');
            var img = jpeg.decode(buffer, { useTArray: true });
            return { width: img.width, height: img.height, rgba: img.data };
        }
    } catch (e) {
        return null;
    }
    return null;
}

function isPng(buffer) {
    return buffer && buffer.length > 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
}

function isJpeg(buffer) {
    return buffer && buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8;
}

function toGray(img) {
    var n = img.width * img.height;
    var gray = new Uint8Array(n);
    var d = img.rgba;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
        gray[i] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) | 0;
    }
    return gray;
}

// Nguong Otsu + tu doan dau la "muc" (chu).
function analyzeInk(gray) {
    var hist = new Array(256);
    for (var i = 0; i < 256; i++) hist[i] = 0;
    for (var j = 0; j < gray.length; j++) hist[gray[j]]++;

    var total = gray.length;
    var sum = 0;
    for (var t = 0; t < 256; t++) sum += t * hist[t];

    var sumB = 0, wB = 0, best = -1, thr = 127;
    for (var k = 0; k < 256; k++) {
        wB += hist[k];
        if (wB === 0) continue;
        var wF = total - wB;
        if (wF === 0) break;
        sumB += k * hist[k];
        var mB = sumB / wB;
        var mF = (sum - sumB) / wF;
        var between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; thr = k; }
    }
    var dark = 0;
    for (var d2 = 0; d2 <= thr; d2++) dark += hist[d2];
    // Lop chiem IT diem anh hon thuong la CHU (chu chiem ~5-20% trang giay).
    return { thr: thr, inkIsDark: dark <= (total - dark) };
}

function isInk(v, ink) {
    return ink.inkIsDark ? v <= ink.thr : v > ink.thr;
}

// Tim cac doan muc lien tuc tren 1 hang anh, trong khoang x [x0, x1].
// Tra ve do dai doan DAI NHAT (dung cho debug/thong ke).
function longestRunInRow(gray, width, y, x0, x1, ink) {
    var best = 0;
    var start = -1;
    var row = y * width;
    for (var x = x0; x <= x1; x++) {
        var on = isInk(gray[row + x], ink);
        if (on) {
            if (start < 0) start = x;
        } else if (start >= 0) {
            if (x - start > best) best = x - start;
            start = -1;
        }
    }
    if (start >= 0 && (x1 - start + 1) > best) best = x1 - start + 1;
    return best;
}

/**
 * Xac dinh dong nao bi gach chan.
 * @param {Buffer} buffer  noi dung anh
 * @param {string} mime
 * @param {Array}  lines   [{ bbox:{x0,y0,x1,y1}, baseline?:{y0}, text:string }]
 * @returns {boolean[]}    true tai vi tri dong bi gach chan (false neu khong doc duoc anh)
 */
function detectUnderlinedLines(buffer, mime, lines) {
    var flags = [];
    if (!Array.isArray(lines) || lines.length === 0) return flags;
    for (var z = 0; z < lines.length; z++) flags.push(false);

    var img = decodeGray(buffer, mime);
    if (!img) return flags;

    var gray = toGray(img);
    var ink = analyzeInk(gray);
    var W = img.width, H = img.height;

    // Dong ke tiep (theo chieu doc) cua tung dong: dung de chan duoi vung tim,
    // tranh lan sang dong chu ben duoi.
    var tops = [];
    for (var q = 0; q < lines.length; q++) {
        var qb = lines[q] && lines[q].bbox;
        if (qb && typeof qb.y0 === 'number') tops.push(qb.y0);
    }
    tops.sort(function (a, b) { return a - b; });

    function nextTopAfter(y) {
        for (var t = 0; t < tops.length; t++) { if (tops[t] > y) return tops[t]; }
        return H;
    }

    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var bb = ln && ln.bbox;
        if (!bb || typeof bb.y0 !== 'number' || typeof bb.y1 !== 'number') continue;

        var h = bb.y1 - bb.y0;
        if (h <= 0) continue;
        var minRun = Math.max(MIN_RUN_PX, Math.round(h * MIN_RUN_RATIO));

        // Duong baseline: gach chan nam NGAY DUOI do.
        // Cua so tim trai tu duoi baseline xuong sat dong chu ke tiep: gach chan
        // co the nam sat chan chu (de in tu Word) hoac thap hon (anh chup, anh do
        // phan mem khac ve ra). Ngưỡng do dai doan muc moi la yeu to loc chinh.
        var baseY = (ln.baseline && typeof ln.baseline.y0 === 'number') ? ln.baseline.y0 : bb.y1;
        var yFrom = Math.max(0, baseY + 1);
        var wanted = Math.max(baseY + Math.round(h * 0.55), bb.y1 + Math.round(h * 0.35));
        var yTo = Math.min(H - 1, Math.max(yFrom, Math.min(wanted, nextTopAfter(bb.y1) - 1)));
        var xFrom = Math.max(0, bb.x0 - X_PAD);
        var xTo = Math.min(W - 1, bb.x1 + X_PAD);

        var best = 0;
        for (var y = yFrom; y <= yTo; y++) {
            var run = longestRunInRow(gray, W, y, xFrom, xTo, ink);
            if (run > best) best = run;
            if (run >= minRun) { flags[i] = true; break; }
        }
        if (DEBUG) {
            console.log('[underline] dong ' + i + ' h=' + h + ' baseline=' + baseY +
                ' y=' + yFrom + '..' + yTo + ' minRun=' + minRun + ' runDaiNhat=' + best +
                ' -> ' + (flags[i] ? 'GACH CHAN' : 'khong') + ' | ' + String((ln.text || '')).trim().slice(0, 50));
        }
    }
    return flags;
}

// Chi xet cac dong "trong nhu mot dap an" (A. / B) / c. ...) -> tranh them dau
// vao dong cau hoi hay dong trang tri.
var OPTION_LINE_RX = /^[A-Za-z][.)]\s*\S/;

function looksLikeOptionLine(text) {
    return OPTION_LINE_RX.test(String(text || '').trim());
}

/**
 * Ghep ket qua gach chan vao van ban OCR bang cach them dau "*" cuoi dong.
 * Nho vay toan bo phan phan tich cau hoi phia sau (von da hieu dau "*")
 * khong phai sua gi.
 *
 * Dong OCR va dong trong van ban duoc ghep theo THU TU va phai khop noi dung;
 * neu lech -> bo qua (khong danh dau) de khong bao gio danh sai dap an.
 *
 * @param {string} text   van ban OCR (data.text)
 * @param {Array}  lines  danh sach dong OCR co toa do
 * @param {boolean[]} flags
 * @param {string} [marker] mac dinh ' *'
 * @returns {{text:string, marked:number}}
 */
function applyUnderlineMarkers(text, lines, flags, marker) {
    var out = { text: text, marked: 0 };
    if (!text || !Array.isArray(lines) || !Array.isArray(flags)) return out;

    var mk = marker || ' *';
    var textLines = String(text).split('\n');

    // Danh sach dong OCR chi gom dong co noi dung, theo dung thu tu xuat hien
    var ocrLines = [];
    for (var i = 0; i < lines.length; i++) {
        var t = String(lines[i] && lines[i].text || '').replace(/\s+/g, ' ').trim();
        if (t) ocrLines.push({ text: t, underlined: !!flags[i] });
    }

    var changed = false;
    var oi = 0;
    for (var li = 0; li < textLines.length; li++) {
        var cur = textLines[li].replace(/\s+/g, ' ').trim();
        if (!cur) continue;
        var cand = ocrLines[oi];
        if (!cand) break;
        if (cand.text !== cur) continue;      // lech -> bo qua dong nay
        oi++;
        if (!cand.underlined) continue;
        if (!looksLikeOptionLine(cur)) continue;
        if (/\*/.test(cur)) continue;         // da co dau roi
        textLines[li] = textLines[li].replace(/\s*$/, '') + mk;
        changed = true;
        out.marked++;
    }
    if (changed) out.text = textLines.join('\n');
    return out;
}

module.exports = {
    detectUnderlinedLines: detectUnderlinedLines,
    applyUnderlineMarkers: applyUnderlineMarkers,
    looksLikeOptionLine: looksLikeOptionLine
};
