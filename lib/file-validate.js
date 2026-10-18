'use strict';
/**
 * lib/file-validate.js
 * ---------------------------------------------------------------------------
 * Kiem tra tep tai len cho tinh nang "Nhap de thi tu Word / anh".
 *
 * Nguyen tac:
 *   - KHONG BAO GIO thuc thi tep tai len (chi doc byte de nhan dang).
 *   - Kiem tra 3 lop: phan mo rong (ten file), MIME type (client khai bao),
 *     va magic bytes (noi dung thuc te). Client co the gia mao 2 lop dau,
 *     nen magic bytes la lop quyet dinh.
 *   - Gioi han dung luong ro rang.
 *
 * Xuat:
 *   FILE_LIMITS            - cac gioi han dang dung
 *   detectKind(name,mime)  - doan loai theo ten + MIME ('docx'|'image'|null)
 *   validateUpload(file)   - kiem tra day du 1 file multer -> ket qua
 */

var FILE_LIMITS = {
    maxDocxBytes: 15 * 1024 * 1024,   // 15 MB
    maxImageBytes: 8 * 1024 * 1024,   //  8 MB
    maxImageCount: 30,                // toi da 30 anh / 1 lan nhap
    maxTotalBytes: 25 * 1024 * 1024   // 25 MB tong cong
};

var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
var DOCX_EXTS = ['.docx'];

// Cac dinh dang anh ho tro: ext, MIME hop le, ham kiem tra magic bytes
var IMAGE_TYPES = [
    {
        ext: ['.png'], mimes: ['image/png'], out: 'image/png',
        sig: function (b) {
            return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
                b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A;
        }
    },
    {
        ext: ['.jpg', '.jpeg'], mimes: ['image/jpeg', 'image/jpg', 'image/pjpeg'], out: 'image/jpeg',
        sig: function (b) { return b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF; }
    },
    {
        ext: ['.gif'], mimes: ['image/gif'], out: 'image/gif',
        sig: function (b) { return b.length >= 6 && b.slice(0, 3).toString('latin1') === 'GIF'; }
    },
    {
        ext: ['.bmp'], mimes: ['image/bmp', 'image/x-ms-bmp'], out: 'image/bmp',
        sig: function (b) { return b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D; }
    },
    {
        ext: ['.webp'], mimes: ['image/webp'], out: 'image/webp',
        sig: function (b) {
            return b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' &&
                b.slice(8, 12).toString('latin1') === 'WEBP';
        }
    }
];

function lower(s) { return String(s || '').toLowerCase(); }

function extOf(name) {
    var n = lower(name);
    var i = n.lastIndexOf('.');
    return i >= 0 ? n.slice(i) : '';
}

// .docx thuc chat la 1 file ZIP -> bat dau bang "PK" + 1 trong 3 byte 03/05/07
function isZip(buffer) {
    return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B &&
        (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
}

function imageTypeByExt(ext) {
    for (var i = 0; i < IMAGE_TYPES.length; i++) {
        if (IMAGE_TYPES[i].ext.indexOf(ext) >= 0) return IMAGE_TYPES[i];
    }
    return null;
}

function imageTypeByMime(mime) {
    for (var i = 0; i < IMAGE_TYPES.length; i++) {
        if (IMAGE_TYPES[i].mimes.indexOf(lower(mime)) >= 0) return IMAGE_TYPES[i];
    }
    return null;
}

function imageTypeBySig(buffer) {
    for (var i = 0; i < IMAGE_TYPES.length; i++) {
        try { if (IMAGE_TYPES[i].sig(buffer)) return IMAGE_TYPES[i]; } catch (e) { /* ignore */ }
    }
    return null;
}

/**
 * Doan loai file chi dua tren metadata (dung cho multer fileFilter).
 * KHONG dung de quyet dinh cuoi cung.
 */
function detectKind(name, mime) {
    var ext = extOf(name);
    var m = lower(mime);
    if (DOCX_EXTS.indexOf(ext) >= 0) return 'docx';
    if (m === DOCX_MIME) return 'docx';
    if (imageTypeByExt(ext)) return 'image';
    if (imageTypeByMime(m)) return 'image';
    return null;
}

/**
 * Kiem tra day du 1 file (co buffer) -> { ok, kind, imageType, error }
 *   kind: 'docx' | 'image'
 *   imageType: MIME chuan de nhung base64 (chi khi kind='image')
 */
function validateUpload(file) {
    if (!file || !file.buffer || !file.buffer.length) {
        return { ok: false, error: 'File rỗng hoặc không đọc được.' };
    }

    var name = file.originalname || '';
    var mime = lower(file.mimetype);
    var ext = extOf(name);
    var buffer = file.buffer;
    var size = buffer.length;

    var metaKind = detectKind(name, file.mimetype);
    if (!metaKind) {
        return {
            ok: false,
            error: 'Định dạng không hỗ trợ: "' + name + '". Chỉ nhận .docx và ảnh (' +
                IMAGE_TYPES.map(function (t) { return t.ext.join('/'); }).join(', ') + ').'
        };
    }

    if (metaKind === 'docx') {
        if (size > FILE_LIMITS.maxDocxBytes) {
            return { ok: false, error: 'File Word quá lớn (' + mb(size) + ' MB). Tối đa ' + mb(FILE_LIMITS.maxDocxBytes) + ' MB.' };
        }
        if (!isZip(buffer)) {
            return { ok: false, error: 'File "' + name + '" không phải tài liệu .docx hợp lệ (nội dung không đúng định dạng).' };
        }
        return { ok: true, kind: 'docx' };
    }

    // kind === 'image'
    if (size > FILE_LIMITS.maxImageBytes) {
        return { ok: false, error: 'Ảnh "' + name + '" quá lớn (' + mb(size) + ' MB). Tối đa ' + mb(FILE_LIMITS.maxImageBytes) + ' MB.' };
    }

    var byExt = imageTypeByExt(ext);
    var bySig = imageTypeBySig(buffer);
    if (!bySig) {
        return { ok: false, error: 'Ảnh "' + name + '" không đúng định dạng (kiểm tra nội dung thất bại).' };
    }
    // Neu ten file khai bao 1 loai anh khac voi noi dung thuc te -> tu choi
    if (byExt && byExt.out !== bySig.out) {
        return { ok: false, error: 'Ảnh "' + name + '" có phần mở rộng không khớp với nội dung thực tế.' };
    }
    // Neu MIME khai bao ro rang khac voi noi dung thuc te -> tu choi
    if (mime && mime.indexOf('image/') === 0) {
        var byMime = imageTypeByMime(mime);
        if (byMime && byMime.out !== bySig.out) {
            return { ok: false, error: 'Ảnh "' + name + '" có MIME type không khớp với nội dung thực tế.' };
        }
    }

    return { ok: true, kind: 'image', imageType: bySig.out };
}

function mb(bytes) {
    return (bytes / 1024 / 1024).toFixed(1);
}

module.exports = {
    FILE_LIMITS: FILE_LIMITS,
    DOCX_MIME: DOCX_MIME,
    detectKind: detectKind,
    validateUpload: validateUpload,
    isZip: isZip
};
