'use strict';
/**
 * Test import Word: đọc bảng đáp án ở cuối file và ghép vào đúng phần/câu/ý.
 *
 * Yêu cầu server đang chạy với TEACHER_PASSWORD=test123 (nên dùng thư mục data
 * tạm/trống để không lẫn dữ liệu thật):
 *   $env:PORT='3999'; $env:TEACHER_PASSWORD='test123'; node server.js
 *   node tests/test-answer-tables.js
 *
 * Đổi địa chỉ bằng TEST_BASE (mặc định http://127.0.0.1:3999).
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

async function preview(cookie, buffer, name) {
    const fd = new FormData();
    fd.append('files', new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }), name || 'de.docx');
    const res = await fetch(BASE + '/api/import/preview', {
        method: 'POST', headers: { Cookie: cookie }, body: fd
    });
    return { status: res.status, json: await res.json().catch(function () { return null; }) };
}

async function confirm(cookie, body) {
    const res = await fetch(BASE + '/api/import/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body)
    });
    return { status: res.status, json: await res.json().catch(function () { return null; }) };
}

async function submit(answers, stt) {
    const res = await fetch(BASE + '/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            studentSTT: String(stt),
            studentName: 'Test bảng đáp án',
            studentClass: 'Test',
            answers: answers,
            timeSpent: '1 phút'
        })
    });
    return await res.json();
}

function tableSummary(json) {
    return (json && json.answerTables && json.answerTables.tables) || [];
}

// ---------------------------------------------------------------------------
// Các mẫu DOCX
// ---------------------------------------------------------------------------

function singleQuestion(n, text, correctAt) {
    const letters = ['A', 'B', 'C', 'D'];
    const out = [new Paragraph('Câu ' + n + '. ' + text)];
    letters.forEach(function (l, i) {
        out.push(new Paragraph(l + '. ' + (i === correctAt ? 'đúng *' : 'phương án ' + i)));
    });
    return out;
}

async function buildHorizontalSingle() {
    return docx([
        ...singleQuestion(1, 'Một cộng một bằng mấy?', 1),
        ...singleQuestion(2, 'Hai cộng hai bằng mấy?', 2),
        new Paragraph('ĐÁP ÁN TRẮC NGHIỆM'),
        table([
            ['Câu', '1', '2'].map(function (t) { return { text: t }; }),
            ['Đáp án', 'B', 'C'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildVerticalSingle() {
    return docx([
        new Paragraph('PHẦN I. TRẮC NGHIỆM NHIỀU PHƯƠNG ÁN'),
        ...singleQuestion(1, 'Thủ đô Việt Nam?', 1),
        ...singleQuestion(2, 'Một cộng hai bằng mấy?', 2),
        new Paragraph('ĐÁP ÁN PHẦN I'),
        table([
            ['Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', 'B'].map(function (t) { return { text: t }; }),
            ['2', 'C'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildTrueFalse() {
    return docx([
        new Paragraph('PHẦN II. CÂU TRẮC NGHIỆM ĐÚNG SAI'),
        new Paragraph('Câu 1. Xét các phát biểu sau:'),
        new Paragraph('a) Nước có công thức H2O.'),
        new Paragraph('b) Nước không dẫn điện.'),
        new Paragraph('c) Nước đóng băng ở 0 độ C.'),
        new Paragraph('d) Nước có vị ngọt.'),
        new Paragraph('ĐÁP ÁN TRẮC NGHIỆM ĐÚNG SAI'),
        table([
            ['Câu', 'Lệnh hỏi', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', 'a', 'Đ'].map(function (t) { return { text: t }; }),
            ['1', 'b', 'S'].map(function (t) { return { text: t }; }),
            ['1', 'c', 'Đ'].map(function (t) { return { text: t }; }),
            ['1', 'd', 'S'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildTrueFalseTwoGroups() {
    return docx([
        new Paragraph('PHẦN II. CÂU TRẮC NGHIỆM ĐÚNG SAI'),
        new Paragraph('Câu 1. Xét các phát biểu sau:'),
        new Paragraph('a) Mệnh đề 1a.'), new Paragraph('b) Mệnh đề 1b.'),
        new Paragraph('c) Mệnh đề 1c.'), new Paragraph('d) Mệnh đề 1d.'),
        new Paragraph('Câu 2. Xét các phát biểu sau:'),
        new Paragraph('a) Mệnh đề 2a.'), new Paragraph('b) Mệnh đề 2b.'),
        new Paragraph('c) Mệnh đề 2c.'), new Paragraph('d) Mệnh đề 2d.'),
        new Paragraph('ĐÁP ÁN PHẦN II'),
        table([
            ['Câu', 'Lệnh hỏi', 'Đáp án', 'Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            [{ text: '1', vMerge: VerticalMergeType.RESTART }, { text: 'a' }, { text: 'Đ' },
                { text: '2', vMerge: VerticalMergeType.RESTART }, { text: 'Đ' }],
            [{ text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'b' }, { text: 'Đ' },
                { text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'S' }],
            [{ text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'c' }, { text: 'S' },
                { text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'Đ' }],
            [{ text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'd' }, { text: 'S' },
                { text: '', vMerge: VerticalMergeType.CONTINUE }, { text: 'S' }]
        ])
    ]);
}

async function buildShortTwoPairs() {
    return docx([
        new Paragraph('PHẦN III. TRẮC NGHIỆM TRẢ LỜI NGẮN'),
        new Paragraph('Câu 1. Tính 2 + 3.'),
        new Paragraph('Câu 2. Tính 8 x 3.'),
        new Paragraph('ĐÁP ÁN TRẮC NGHIỆM TRẢ LỜI NGẮN'),
        table([
            [{ text: 'Câu', span: 2 }, { text: 'Đáp án', span: 2 }, { text: 'Câu', span: 2 }, { text: 'Đáp án', span: 2 }],
            [{ text: '1', span: 2 }, { text: '3', span: 2 }, { text: '2', span: 2 }, { text: '24', span: 2 }]
        ])
    ]);
}

async function buildMissingAnswer() {
    return docx([
        new Paragraph('PHẦN I. TRẮC NGHIỆM'),
        ...singleQuestion(1, 'Câu có đáp án?', 1),
        // Câu 2 không đánh dấu đáp án trong đề; bảng cũng thiếu câu 2.
        ...singleQuestion(2, 'Câu thiếu đáp án?', -1),
        new Paragraph('ĐÁP ÁN PHẦN I'),
        table([
            ['Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', 'B'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildEmptyCell() {
    return docx([
        new Paragraph('PHẦN III. TRẮC NGHIỆM TRẢ LỜI NGẮN'),
        new Paragraph('Câu 1. Tính 7 + 1.'),
        new Paragraph('ĐÁP ÁN PHẦN III'),
        table([
            ['Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', ''].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildDecimalShort() {
    return docx([
        new Paragraph('PHẦN III. TRẮC NGHIỆM TRẢ LỜI NGẮN'),
        new Paragraph('Câu 1. Nhiệt độ là bao nhiêu?'),
        new Paragraph('Câu 2. Khối lượng là bao nhiêu?'),
        new Paragraph('ĐÁP ÁN PHẦN III'),
        table([
            ['Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', '-3,5'].map(function (t) { return { text: t }; }),
            ['2', '24.00'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildConflict() {
    return docx([
        new Paragraph('PHẦN I. TRẮC NGHIỆM'),
        ...singleQuestion(1, 'Câu có hai đáp án mâu thuẫn?', -1),
        new Paragraph('ĐÁP ÁN PHẦN I'),
        table([
            ['Câu', 'Đáp án', 'Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', 'A', '1', 'B'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildInvalidAnswer() {
    return docx([
        new Paragraph('PHẦN I. TRẮC NGHIỆM'),
        ...singleQuestion(1, 'Câu có đáp án không hợp lệ?', -1),
        new Paragraph('ĐÁP ÁN PHẦN I'),
        table([
            ['Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', 'Z'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildExtraAnswer() {
    return docx([
        new Paragraph('PHẦN I. TRẮC NGHIỆM'),
        ...singleQuestion(1, 'Chỉ có một câu?', -1),
        new Paragraph('ĐÁP ÁN PHẦN I'),
        table([
            ['Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', 'A'].map(function (t) { return { text: t }; }),
            ['2', 'B'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildUnrecognizedHeading() {
    return docx([
        new Paragraph('PHẦN I. TRẮC NGHIỆM'),
        ...singleQuestion(1, 'Câu chưa có đáp án?', -1),
        new Paragraph('HƯỚNG DẪN CHẤM'),
        table([
            ['Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', 'A'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildNoTable() {
    return docx([
        new Paragraph('Câu 1. Thủ đô Việt Nam?'),
        new Paragraph('A. TP. Hồ Chí Minh'),
        new Paragraph('B. Hà Nội *'),
        new Paragraph('C. Đà Nẵng'),
        new Paragraph('D. Cần Thơ')
    ]);
}

async function buildHorizontalParts() {
    return docx([
        new Paragraph('PHẦN II. CÂU TRẮC NGHIỆM ĐÚNG SAI'),
        new Paragraph('Câu 1. Xét các phát biểu sau:'),
        new Paragraph('a) Mệnh đề a.'), new Paragraph('b) Mệnh đề b.'),
        new Paragraph('c) Mệnh đề c.'), new Paragraph('d) Mệnh đề d.'),
        new Paragraph('ĐÁP ÁN TRẮC NGHIỆM ĐÚNG SAI'),
        table([
            ['Câu', 'a', 'b', 'c', 'd'].map(function (t) { return { text: t }; }),
            ['1', 'Đ', 'S', 'Đ', 'S'].map(function (t) { return { text: t }; })
        ])
    ]);
}

async function buildFullFlow() {
    return docx([
        new Paragraph('PHẦN I. TRẮC NGHIỆM NHIỀU PHƯƠNG ÁN'),
        ...singleQuestion(1, '1 + 1 bằng bao nhiêu?', 1),
        ...singleQuestion(2, '2 + 2 bằng bao nhiêu?', 2),
        new Paragraph('PHẦN II. CÂU TRẮC NGHIỆM ĐÚNG SAI'),
        new Paragraph('Câu 1. Xét các phát biểu sau:'),
        new Paragraph('a) Nước có công thức H2O.'),
        new Paragraph('b) Nước không dẫn điện.'),
        new Paragraph('c) Nước đóng băng ở 0 độ C.'),
        new Paragraph('d) Nước có vị ngọt.'),
        new Paragraph('PHẦN III. TRẮC NGHIỆM TRẢ LỜI NGẮN'),
        new Paragraph('Câu 1. Tính 2 + 3.'),
        new Paragraph('Câu 2. Tính 8 x 3.'),
        new Paragraph('ĐÁP ÁN PHẦN I'),
        table([
            ['Câu', '1', '2'].map(function (t) { return { text: t }; }),
            ['Đáp án', 'B', 'C'].map(function (t) { return { text: t }; })
        ]),
        new Paragraph('ĐÁP ÁN PHẦN II'),
        table([
            ['Câu', 'Lệnh hỏi', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', 'a', 'Đ'].map(function (t) { return { text: t }; }),
            ['1', 'b', 'Đ'].map(function (t) { return { text: t }; }),
            ['1', 'c', 'S'].map(function (t) { return { text: t }; }),
            ['1', 'd', 'Đ'].map(function (t) { return { text: t }; })
        ]),
        new Paragraph('ĐÁP ÁN PHẦN III'),
        table([
            ['Câu', 'Đáp án', 'Câu', 'Đáp án'].map(function (t) { return { text: t }; }),
            ['1', '3', '2', '24'].map(function (t) { return { text: t }; })
        ])
    ]);
}

// ---------------------------------------------------------------------------

(async function main() {
    let cookie;
    try {
        cookie = await login();
    } catch (e) {
        console.error('\nKhông đăng nhập được: ' + e.message);
        console.error('Hãy chạy: $env:PORT=\'3999\'; $env:TEACHER_PASSWORD=\'test123\'; node server.js');
        process.exit(2);
    }

    console.log('\n=== 1. Bảng trắc nghiệm theo hàng ngang ===');
    const p1 = await preview(cookie, await buildHorizontalSingle());
    const q1 = (p1.json && p1.json.questions) || [];
    check('preview thành công', p1.json && p1.json.success === true, JSON.stringify(p1.json).slice(0, 300));
    check('có 2 câu, không có câu nào từ bảng', q1.length === 2, 'count=' + q1.length);
    check('câu 1 nhận B', q1[0] && q1[0].correct === 1, q1[0] && q1[0].correct);
    check('câu 2 nhận C', q1[1] && q1[1].correct === 2, q1[1] && q1[1].correct);
    check('không câu nào cần kiểm tra', q1.every(function (q) { return q.needsReview === false; }));
    check('báo cáo 1 bảng đáp án', tableSummary(p1.json).length === 1, JSON.stringify(tableSummary(p1.json)));
    check('không lẫn tiêu đề bảng vào câu hỏi', q1.every(function (q) { return !/ĐÁP ÁN|Đáp án/.test(q.question); }));

    console.log('\n=== 2. Bảng trắc nghiệm theo hàng dọc ===');
    const p2 = await preview(cookie, await buildVerticalSingle());
    const q2 = (p2.json && p2.json.questions) || [];
    check('có 2 câu', q2.length === 2, 'count=' + q2.length);
    check('câu 1 nhận B', q2[0] && q2[0].correct === 1, q2[0] && q2[0].correct);
    check('câu 2 nhận C', q2[1] && q2[1].correct === 2, q2[1] && q2[1].correct);
    check('nhận đúng phần I và số câu', q2[0] && q2[0].importSection === 'Phần I' && q2[0].importNumber === 1, JSON.stringify(q2[0] && { s: q2[0].importSection, n: q2[0].importNumber }));

    console.log('\n=== 3. Bảng Đúng/Sai có ý a, b, c, d ===');
    const p3 = await preview(cookie, await buildTrueFalse());
    const q3 = (p3.json && p3.json.questions) || [];
    check('có 1 câu đúng/sai', q3.length === 1 && q3[0].type === 'truefalse', q3[0] && q3[0].type);
    check('ghép đúng Đ/S từng ý', q3[0] && JSON.stringify(q3[0].correctTF) === JSON.stringify([true, false, true, false]), q3[0] && JSON.stringify(q3[0].correctTF));
    check('câu đúng/sai không cần kiểm tra', q3[0] && q3[0].needsReview === false, JSON.stringify(q3[0] && q3[0].reviewReasons));

    console.log('\n=== 4. Bảng Đúng/Sai hai cụm cột + ô gộp ===');
    const p4 = await preview(cookie, await buildTrueFalseTwoGroups());
    const q4 = (p4.json && p4.json.questions) || [];
    check('có 2 câu đúng/sai', q4.length === 2 && q4.every(function (q) { return q.type === 'truefalse'; }), 'count=' + q4.length);
    check('câu 1: a Đ, b Đ, c S, d S', q4[0] && JSON.stringify(q4[0].correctTF) === JSON.stringify([true, true, false, false]), q4[0] && JSON.stringify(q4[0].correctTF));
    check('câu 2: a Đ, b S, c Đ, d S', q4[1] && JSON.stringify(q4[1].correctTF) === JSON.stringify([true, false, true, false]), q4[1] && JSON.stringify(q4[1].correctTF));
    check('cả 2 câu không cần kiểm tra', q4.every(function (q) { return q.needsReview === false; }), JSON.stringify(q4.map(function (q) { return q.reviewReasons; })));

    console.log('\n=== 5. Bảng trả lời ngắn hai cặp cột ===');
    const p5 = await preview(cookie, await buildShortTwoPairs());
    const q5 = (p5.json && p5.json.questions) || [];
    check('có 2 câu trả lời ngắn', q5.length === 2 && q5.every(function (q) { return q.type === 'shortanswer'; }), 'count=' + q5.length);
    check('câu 1 = 3', q5[0] && q5[0].correctAnswer === '3', q5[0] && q5[0].correctAnswer);
    check('câu 2 = 24', q5[1] && q5[1].correctAnswer === '24', q5[1] && q5[1].correctAnswer);
    check('không câu nào cần kiểm tra', q5.every(function (q) { return q.needsReview === false; }));

    console.log('\n=== 6. Bảng Đúng/Sai hàng ngang (Câu | a | b | c | d) ===');
    const p6 = await preview(cookie, await buildHorizontalParts());
    const q6 = (p6.json && p6.json.questions) || [];
    check('ghép đúng Đ/S hàng ngang', q6[0] && JSON.stringify(q6[0].correctTF) === JSON.stringify([true, false, true, false]), q6[0] && JSON.stringify(q6[0].correctTF));

    console.log('\n=== 7. Một câu không có đáp án trong bảng ===');
    const p7 = await preview(cookie, await buildMissingAnswer());
    const q7 = (p7.json && p7.json.questions) || [];
    check('câu 1 có đáp án B', q7[0] && q7[0].correct === 1, q7[0] && q7[0].correct);
    check('câu 2 không bị tự gán đáp án', q7[1] && q7[1].correct === null, JSON.stringify(q7[1]));
    check('câu 2 được đánh dấu cần kiểm tra', q7[1] && q7[1].needsReview === true, JSON.stringify(q7[1] && q7[1].reviewReasons));

    console.log('\n=== 8. Ô đáp án trống ===');
    const p8 = await preview(cookie, await buildEmptyCell());
    const q8 = (p8.json && p8.json.questions) || [];
    check('câu trả lời ngắn không có đáp án', q8[0] && q8[0].correctAnswer === null, q8[0] && q8[0].correctAnswer);
    check('được đánh dấu cần kiểm tra', q8[0] && q8[0].needsReview === true, JSON.stringify(q8[0] && q8[0].reviewReasons));
    check('báo cáo ô trống', tableSummary(p8.json)[0] && tableSummary(p8.json)[0].warnings.join(' ').indexOf('trống') >= 0, JSON.stringify(tableSummary(p8.json)));

    console.log('\n=== 8b. Đáp án ngắn âm và thập phân ===');
    const p8b = await preview(cookie, await buildDecimalShort());
    const q8b = (p8b.json && p8b.json.questions) || [];
    check('giữ đúng số âm/thập phân (chuẩn hóa về dấu chấm)', q8b[0] && q8b[0].correctAnswer === '-3.5', q8b[0] && q8b[0].correctAnswer);
    check('giữ đúng 24.00 thành 24', q8b[1] && q8b[1].correctAnswer === '24', q8b[1] && q8b[1].correctAnswer);

    console.log('\n=== 8c. Hai đáp án mâu thuẫn cho cùng câu ===');
    const p8c = await preview(cookie, await buildConflict());
    const q8c = (p8c.json && p8c.json.questions) || [];
    check('câu bị đánh dấu cần kiểm tra', q8c[0] && q8c[0].needsReview === true, JSON.stringify(q8c[0] && q8c[0].reviewReasons));
    check('có cảnh báo mâu thuẫn', q8c[0] && q8c[0].answerWarnings && q8c[0].answerWarnings.join(' ').indexOf('nhiều giá trị') >= 0, JSON.stringify(q8c[0] && q8c[0].answerWarnings));

    console.log('\n=== 8d. Đáp án không hợp lệ (Z) ===');
    const p8d = await preview(cookie, await buildInvalidAnswer());
    const q8d = (p8d.json && p8d.json.questions) || [];
    check('không gán đáp án sai', q8d[0] && q8d[0].correct === null, q8d[0] && q8d[0].correct);
    check('đánh dấu cần kiểm tra', q8d[0] && q8d[0].needsReview === true, JSON.stringify(q8d[0] && q8d[0].reviewReasons));

    console.log('\n=== 8e. Đáp án thừa (không có câu tương ứng) ===');
    const p8e = await preview(cookie, await buildExtraAnswer());
    check('báo đáp án câu 2 không ghép được', tableSummary(p8e.json)[0] && tableSummary(p8e.json)[0].warnings.join(' ').indexOf('không ghép được') >= 0, JSON.stringify(tableSummary(p8e.json)));

    console.log('\n=== 8f. Bảng giống đáp án nhưng sai tiêu đề ===');
    const p8f = await preview(cookie, await buildUnrecognizedHeading());
    const q8f = (p8f.json && p8f.json.questions) || [];
    check('không tự ghép khi tiêu đề không phải ĐÁP ÁN', q8f[0] && q8f[0].correct === null, q8f[0] && q8f[0].correct);
    check('có cảnh báo tiêu đề', p8f.json && p8f.json.answerTables && p8f.json.answerTables.warnings.join(' ').indexOf('tiêu đề') >= 0, JSON.stringify(p8f.json && p8f.json.answerTables));

    console.log('\n=== 9. File không có bảng đáp án ===');
    const p9 = await preview(cookie, await buildNoTable());
    const q9 = (p9.json && p9.json.questions) || [];
    check('vẫn nhận câu hỏi bình thường', q9.length === 1 && q9[0].type === 'single', 'count=' + q9.length);
    check('vẫn nhận đáp án gạch chân/dấu *', q9[0] && q9[0].correct === 1, q9[0] && q9[0].correct);
    check('không có báo cáo bảng', !p9.json.answerTables || tableSummary(p9.json).length === 0, JSON.stringify(p9.json.answerTables));

    console.log('\n=== 10. Bảng đáp án nằm sau đề, không thành câu hỏi ===');
    const p10 = await preview(cookie, await buildFullFlow());
    const q10 = (p10.json && p10.json.questions) || [];
    check('đúng 5 câu hỏi (2 + 1 + 2)', q10.length === 5, 'count=' + q10.length);
    check('không có câu nào chứa tiêu đề bảng', q10.every(function (q) { return !/ĐÁP ÁN PHẦN/.test(q.question); }));
    check('đọc 3 bảng đáp án', tableSummary(p10.json).length === 3, JSON.stringify(tableSummary(p10.json)));
    check('các phần đều đánh số từ 1 và ghép đúng phần',
        q10[0] && q10[0].importSection === 'Phần I' && q10[0].importNumber === 1 &&
        q10[2] && q10[2].importSection === 'Phần II' && q10[2].importNumber === 1 &&
        q10[3] && q10[3].importSection === 'Phần III' && q10[3].importNumber === 1,
        JSON.stringify(q10.map(function (q) { return { s: q.importSection, n: q.importNumber, t: q.type }; })));
    check('câu 2 trả lời ngắn nhận 24 (không nhầm với phần I)',
        q10[4] && q10[4].correctAnswer === '24', q10[4] && q10[4].correctAnswer);
    check('không còn câu nào cần kiểm tra', q10.every(function (q) { return q.needsReview === false; }), JSON.stringify(q10.map(function (q) { return q.reviewReasons; })));

    console.log('\n=== 11. Lưu database -> mở đề -> không lộ đáp án -> chấm điểm ===');
    const c = await confirm(cookie, {
        sessionId: p10.json.sessionId,
        destination: 'current',
        questions: q10.map(function (q) {
            return {
                include: true, type: q.type, question: q.question, options: q.options,
                correct: q.correct, correctList: q.correctList, correctTF: q.correctTF,
                correctAnswer: q.correctAnswer
            };
        })
    });
    check('lưu thành công 5 câu', c.json && c.json.success === true && c.json.saved === 5, JSON.stringify(c.json).slice(0, 400));
    check('không bỏ qua câu nào', c.json && c.json.skipped.length === 0, JSON.stringify(c.json && c.json.skipped));

    const saved = await (await fetch(BASE + '/api/questions', { headers: { Cookie: cookie } })).json();
    check('ngân hàng câu hỏi có 5 câu', Array.isArray(saved) && saved.length === 5, 'len=' + (Array.isArray(saved) ? saved.length : '?'));
    const savedShort = (saved || []).filter(function (q) { return q.type === 'shortanswer'; });
    check('đáp án trả lời ngắn được lưu đúng', savedShort.length === 2 && savedShort[0].correctAnswer === '3' && savedShort[1].correctAnswer === '24', JSON.stringify(savedShort.map(function (q) { return q.correctAnswer; })));

    await fetch(BASE + '/api/exam/open', { method: 'POST', headers: { Cookie: cookie } });
    const exam = await (await fetch(BASE + '/api/exam')).json();
    check('đề mở có 5 câu', exam.questions && exam.questions.length === 5, exam.questions && exam.questions.length);
    const payload = JSON.stringify(exam);
    check('không lộ correctAnswer', payload.indexOf('"correctAnswer"') === -1);
    check('không lộ correctTF', payload.indexOf('"correctTF"') === -1);
    check('không lộ đáp án đúng của câu một đáp án', payload.indexOf('"correct"') === -1);

    const correctAnswers = exam.questions.map(function (q) {
        if (q.type === 'single') return /1 \+ 1/.test(q.question) ? 1 : 2;
        if (q.type === 'truefalse') return [true, true, false, true];
        if (/2 \+ 3/.test(q.question)) return '3';
        return '24';
    });
    const r1 = await submit(correctAnswers, 950);
    check('nộp đúng được 5/5 câu', r1 && r1.correctCount === 5 && r1.wrongCount === 0, JSON.stringify({ c: r1 && r1.correctCount, w: r1 && r1.wrongCount }));

    const nearAnswers = exam.questions.map(function (q) {
        if (q.type === 'single') return /1 \+ 1/.test(q.question) ? 1 : 2;
        if (q.type === 'truefalse') return [true, true, false, true];
        if (/2 \+ 3/.test(q.question)) return '3,0';
        return '24.00';
    });
    const r2 = await submit(nearAnswers, 951);
    check('chấp nhận 3,0 và 24.00', r2 && r2.correctCount === 5, JSON.stringify(r2 && r2.correctCount));

    const wrongAnswers = exam.questions.map(function (q) {
        if (q.type === 'single') return /1 \+ 1/.test(q.question) ? 0 : 0;
        if (q.type === 'truefalse') return [false, false, true, false];
        return '999';
    });
    const r3 = await submit(wrongAnswers, 952);
    check('đáp án sai bị chấm sai', r3 && r3.correctCount === 0, JSON.stringify({ c: r3 && r3.correctCount, p: r3 && r3.partialCount, w: r3 && r3.wrongCount }));

    console.log('\n----------------------------------------');
    console.log('Kết quả: ' + passed + ' PASS, ' + failed + ' FAIL');
    process.exit(failed ? 1 : 0);
})().catch(function (e) {
    console.error(e);
    process.exit(1);
});
