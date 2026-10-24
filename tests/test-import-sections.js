'use strict';
/**
 * Test import Word: nhận đúng loại câu theo tiêu đề phần.
 *
 * - "PHẦN II. (4,0 điểm) ... học sinh chọn đúng hoặc sai" -> truefalse (trước đây
 *   bị đọc thành single nên bảng "ĐÁP ÁN TRẮC NGHIỆM ĐÚNG SAI" không ghép được).
 * - "PHẦN III. (1,5 điểm) Học sinh trả lời từ câu 1 đến câu 6." (không ghi loại)
 *   nhưng cả phần không có phương án A/B/C/D -> trả lời ngắn.
 * - Phần chỉ MỘT VÀI câu mất phương án thì giữ nguyên single + cần kiểm tra,
 *   không tự đổi cả phần thành trả lời ngắn.
 *
 * Yêu cầu server đang chạy với TEACHER_PASSWORD=test123:
 *   $env:PORT='3999'; $env:TEACHER_PASSWORD='test123'; node server.js
 *   node tests/test-import-sections.js
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { Document, Packer, Paragraph, Table, TableRow, TableCell, VerticalMergeType } = require(path.join(ROOT, 'node_modules', 'docx'));

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3999';
const PASSWORD = process.env.TEST_PASSWORD || 'test123';

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('  PASS  ' + name); }
    else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function cell(text, opts) {
    opts = opts || {};
    return new TableCell({
        children: [new Paragraph(text == null ? '' : String(text))],
        columnSpan: opts.span,
        verticalMerge: opts.vMerge
    });
}
function table(rows) {
    return new Table({
        rows: rows.map(function (r) {
            return new TableRow({ children: r.map(function (c) { return cell(c.text, c); }) });
        })
    });
}
async function docx(children) {
    return Packer.toBuffer(new Document({ sections: [{ children: children }] }));
}

async function login() {
    const res = await fetch(BASE + '/api/teacher/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD })
    });
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    if (!raw || !raw[0]) throw new Error('Không lấy được cookie đăng nhập (HTTP ' + res.status + ')');
    return raw[0].split(';')[0];
}

async function preview(cookie, buffer) {
    const fd = new FormData();
    fd.append('file', new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }), 'de.docx');
    const res = await fetch(BASE + '/api/import/preview', {
        method: 'POST', headers: { Cookie: cookie }, body: fd
    });
    return { status: res.status, json: await res.json().catch(function () { return null; }) };
}

// --- Mẫu 1: đề 2025, PHẦN II ghi "chọn đúng hoặc sai", bảng gộp ô "Câu" ---
async function buildTFWithScoredHeading() {
    function statements(n) {
        return [
            new Paragraph('Câu ' + n + '. Xét các phát biểu sau:'),
            new Paragraph('a) Mệnh đề ' + n + 'a.'),
            new Paragraph('b) Mệnh đề ' + n + 'b.'),
            new Paragraph('c) Mệnh đề ' + n + 'c.'),
            new Paragraph('d) Mệnh đề ' + n + 'd.')
        ];
    }
    return docx([
        new Paragraph('PHẦN II. (4,0 điểm) Học sinh trả lời từ câu 1 đến câu 2. Trong mỗi ý a) b) c) d) ở mỗi câu, học sinh chọn đúng hoặc sai.'),
        ...statements(1),
        ...statements(2),
        new Paragraph('ĐÁP ÁN TRẮC NGHIỆM ĐÚNG SAI'),
        table([
            ['Câu', 'Lệnh hỏi', 'Đáp án (Đ/S)'].map(function (t) { return { text: t }; }),
            [{ text: '1', vMerge: VerticalMergeType.RESTART }, { text: 'a' }, { text: 'Đ' }],
            [{ text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'b' }, { text: 'S' }],
            [{ text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'c' }, { text: 'Đ' }],
            [{ text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'd' }, { text: 'Đ' }],
            [{ text: '2', vMerge: VerticalMergeType.RESTART }, { text: 'a' }, { text: 'S' }],
            [{ text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'b' }, { text: 'Đ' }],
            [{ text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'c' }, { text: 'S' }],
            [{ text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'd' }, { text: 'S' }]
        ])
    ]);
}

// --- Mẫu 2: PHẦN III không ghi "trả lời ngắn", câu không có phương án ---
async function buildShortWithoutTypeHeading() {
    return docx([
        new Paragraph('PHẦN III. (1,5 điểm) Học sinh trả lời từ câu 1 đến câu 2.'),
        new Paragraph('Câu 1. Tính 2 + 3.'),
        new Paragraph('Câu 2. Khối lượng là bao nhiêu?'),
        new Paragraph('ĐÁP ÁN TRẮC NGHIỆM TRẢ LỜI NGẮN'),
        table([
            ['Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', '5'].map(function (t) { return { text: t }; }),
            ['2', '24,5'].map(function (t) { return { text: t }; })
        ])
    ]);
}

// --- Mẫu 3: phần trắc nghiệm nhưng chỉ 1 câu mất phương án -> không đổi loại ---
async function buildPartlyBrokenSection() {
    return docx([
        new Paragraph('PHẦN I. (4,5 điểm) Học sinh trả lời từ câu 1 đến câu 2. Mỗi câu hỏi chỉ chọn một phương án.'),
        new Paragraph('Câu 1. 1 + 1 bằng bao nhiêu?'),
        new Paragraph('A. 1'),
        new Paragraph('B. 2 *'),
        new Paragraph('C. 3'),
        new Paragraph('D. 4'),
        new Paragraph('Câu 2. Câu bị mất các phương án.')
    ]);
}

(async function main() {
    let cookie;
    try {
        cookie = await login();
    } catch (e) {
        console.error('\nKhông đăng nhập được: ' + e.message);
        console.error('Hãy chạy: $env:PORT=\'3999\'; $env:TEACHER_PASSWORD=\'test123\'; node server.js');
        process.exit(2);
    }

    console.log('\n=== 1. PHẦN II ghi "chọn đúng hoặc sai" ===');
    const p1 = await preview(cookie, await buildTFWithScoredHeading());
    const q1 = (p1.json && p1.json.questions) || [];
    check('preview thành công', p1.json && p1.json.success === true, JSON.stringify(p1.json).slice(0, 300));
    check('có 2 câu', q1.length === 2, 'count=' + q1.length);
    check('câu 1 là đúng/sai', q1[0] && q1[0].type === 'truefalse', q1[0] && q1[0].type);
    check('câu 1 nhận Đ/S từ bảng', q1[0] && JSON.stringify(q1[0].correctTF) === JSON.stringify([true, false, true, true]), JSON.stringify(q1[0] && q1[0].correctTF));
    check('câu 2 nhận Đ/S từ bảng', q1[1] && JSON.stringify(q1[1].correctTF) === JSON.stringify([false, true, false, false]), JSON.stringify(q1[1] && q1[1].correctTF));
    check('không câu nào cần kiểm tra', q1.every(function (q) { return q.needsReview === false; }));
    check('bảng đáp án ghép đủ 8 ý', (p1.json.answerTables.tables[0] || {}).applied === 8, JSON.stringify(p1.json.answerTables));

    console.log('\n=== 2. PHẦN III không ghi loại, câu không có phương án ===');
    const p2 = await preview(cookie, await buildShortWithoutTypeHeading());
    const q2 = (p2.json && p2.json.questions) || [];
    check('preview thành công', p2.json && p2.json.success === true, JSON.stringify(p2.json).slice(0, 300));
    check('câu 1 là trả lời ngắn', q2[0] && q2[0].type === 'shortanswer', q2[0] && q2[0].type);
    check('câu 1 nhận đáp án 5', q2[0] && q2[0].correctAnswer === '5', q2[0] && q2[0].correctAnswer);
    check('câu 2 nhận đáp án 24.5', q2[1] && q2[1].correctAnswer === '24.5', q2[1] && q2[1].correctAnswer);
    check('không câu nào cần kiểm tra', q2.every(function (q) { return q.needsReview === false; }));

    console.log('\n=== 3. Phần trắc nghiệm chỉ một câu mất phương án ===');
    const p3 = await preview(cookie, await buildPartlyBrokenSection());
    const q3 = (p3.json && p3.json.questions) || [];
    check('câu 1 vẫn là trắc nghiệm', q3[0] && q3[0].type === 'single', q3[0] && q3[0].type);
    check('câu 2 không bị đổi thành trả lời ngắn', q3[1] && q3[1].type === 'single', q3[1] && q3[1].type);
    check('câu 2 được đánh dấu cần kiểm tra', q3[1] && q3[1].needsReview === true);

    console.log('\n----------------------------------------');
    console.log('Kết quả: ' + passed + ' PASS, ' + failed + ' FAIL');
    process.exit(failed ? 1 : 0);
})().catch(function (e) {
    console.error(e);
    process.exit(1);
});
