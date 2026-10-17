'use strict';
/**
 * lib/ocr-parse.js
 * ---------------------------------------------------------------------------
 * Buoc "phan tich" cua luong OCR: lam sach van ban OCR roi danh gia xem van
 * ban co giong mot de trac nghiem hay khong.
 *
 * Luu y quan trong: module nay KHONG tu tao cau hoi/dap an. Viec tach cau hoi
 * duoc thuc hien boi bo phan tich co san cua server (parseQuestionsFromText)
 * de chi co MOT nguon su that duy nhat. O day chi chuan hoa van ban dau vao.
 *
 * Muc tieu chuan hoa:
 *   - NFC, bo ky tu vo hinh, tab, NBSP
 *   - "Cau 1"/"CAU 1" -> "Câu 1"
 *   - "Câu 1 :" / "Câu 1." / "Câu 1)" -> "Câu 1: "
 *   - "A.xxx" / "A) xxx" / "A/ xxx" / "A- xxx" -> "A. xxx"
 *   - Tach dong khi OCR gop nhieu dap an vao 1 dong
 *   - Bo tien to rac (|, •, ...) va dong chi co so trang
 */

var MAX_TEXT_CHARS = 300000;

// Bo cac ky tu vo hinh / khoang trang dac biet
function cleanChars(t) {
    return t
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\u00A0/g, ' ')
        .replace(/\t/g, ' ');
}

// "Cau 1", "CAU 1", "CÂU 1" -> "Câu 1"
function fixCauWord(t) {
    return t.replace(/^([ \t]*)(cau|câu)\b/gim, '$1Câu');
}

// "Câu 1." / "Câu 1 :" / "Câu 1)" -> "Câu 1: "
function fixCauNumber(t) {
    return t.replace(/\bCâu(\s*\d+)\s*[.:)\-–—]\s*/gi, 'Câu$1: ');
}

// Tien to marker dap an (A., A), A/, A-, A,) -> "A. "
function fixOptionMarker(t) {
    return t.replace(/^([ \t]*)([A-Za-z])\s*[.)\/\-,:]\s*/gm, function (m, sp, letter) {
        return sp + letter.toUpperCase() + '. ';
    });
}

// Neu 1 dong chua >= 2 marker dap an thi tach thanh nhieu dong
function splitInlineOptions(line) {
    var marks = line.match(/(?:^|\s)([A-Da-d])\s*[.)]\s/g);
    if (!marks || marks.length < 2) return line;
    return line.replace(/\s+(?=[A-Da-d]\s*[.)]\s)/g, '\n');
}

// Bo ky tu rac o dau dong (|, •, *, -, ...) nhung giu chu/so
function stripLeadingNoise(line) {
    try {
        return line.replace(/^[^\p{L}\p{N}]+/u, '');
    } catch (e) {
        return line.replace(/^[^0-9A-Za-zÀ-ỹ]+/, '');
    }
}

function normalizeOcrText(raw) {
    if (!raw) return '';
    var t = String(raw);
    if (t.length > MAX_TEXT_CHARS) t = t.slice(0, MAX_TEXT_CHARS);
    if (t.normalize) t = t.normalize('NFC');

    t = cleanChars(t);
    t = t.replace(/\r\n?/g, '\n');

    var lines = t.split('\n').map(function (line) { return line.trim(); });

    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) { out.push(''); continue; }
        line = stripLeadingNoise(line);
        if (!line) continue;
        // Dong chi co so trang / so thu tu trang
        if (/^(?:trang\s*)?\d{1,4}$/i.test(line)) continue;
        line = splitInlineOptions(line);
        var sub = line.split('\n');
        for (var j = 0; j < sub.length; j++) out.push(sub[j].trim());
    }

    t = out.join('\n');
    t = fixCauWord(t);
    t = fixCauNumber(t);
    t = fixOptionMarker(t);

    // Gop nhieu dong trong thanh 1 dong trong
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
}

// Dem so "moc cau hoi" de biet OCR co doc duoc de hay khong
function countQuestionMarkers(text) {
    if (!text) return 0;
    var lines = String(text).split('\n');
    var n = 0;
    for (var i = 0; i < lines.length; i++) {
        if (/^\s*(Câu\s*\d+|\d{1,4}\s*[.):])\s*/i.test(lines[i])) n++;
    }
    return n;
}

// Dem so "moc dap an" (A. B. C. D.)
function countOptionMarkers(text) {
    if (!text) return 0;
    var m = String(text).match(/^\s*[A-Za-z]\s*[.)]\s+\S/gm);
    return m ? m.length : 0;
}

/**
 * Danh gia van ban OCR truoc khi phan tich.
 * @returns {{ normalized:string, questionMarkers:number, optionMarkers:number, looksLikeExam:boolean }}
 */
function analyze(rawText) {
    var normalized = normalizeOcrText(rawText);
    var qm = countQuestionMarkers(normalized);
    var om = countOptionMarkers(normalized);
    return {
        normalized: normalized,
        questionMarkers: qm,
        optionMarkers: om,
        looksLikeExam: qm >= 1 && om >= 2
    };
}

module.exports = {
    MAX_TEXT_CHARS: MAX_TEXT_CHARS,
    normalizeOcrText: normalizeOcrText,
    countQuestionMarkers: countQuestionMarkers,
    countOptionMarkers: countOptionMarkers,
    analyze: analyze
};
