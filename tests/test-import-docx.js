'use strict';
/**
 * Test cho tính năng "Nhập đề thi từ Word (.docx)".
 *
 * Yêu cầu: server đang chạy ở cổng 3999 với TEACHER_PASSWORD=test123.
 *   PowerShell:
 *     $env:PORT='3999'; $env:TEACHER_PASSWORD='test123'; node server.js
 *   Rồi ở cửa sổ khác:
 *     node tests/test-import-docx.js
 *
 * Có thể đổi địa chỉ bằng biến môi trường TEST_BASE (mặc định http://127.0.0.1:3999).
 *
 * Dùng fetch + FormData/Blob có sẵn trong Node >= 18 nên KHÔNG cần cài thêm gì.
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } = require(path.join(ROOT, 'node_modules', 'docx'));
const importSessions = require(path.join(ROOT, 'lib', 'import-sessions'));

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3999';
const PASSWORD = process.env.TEST_PASSWORD || 'test123';

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('  PASS  ' + name); }
    else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

// Ảnh PNG 1x1 hợp lệ
const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64'
);

function blobOf(buffer, type) {
    return new Blob([buffer], { type });
}

// Tạo file .docx thật bằng thư viện `docx`
async function buildSampleDocx() {
    const doc = new Document({
        sections: [{
            children: [
                new Paragraph('Câu 1: Thủ đô của Việt Nam là thành phố nào?'),
                new Paragraph('A. TP. Hồ Chí Minh'),
                new Paragraph('B. Hà Nội *'),
                new Paragraph('C. Đà Nẵng'),
                new Paragraph('D. Cần Thơ'),
                new Paragraph('Câu 2: Kết quả của 2 + 2 bằng bao nhiêu?'),
                new Paragraph('A. 3'),
                new Paragraph('B. 4'),
                new Paragraph('C. 5'),
                new Paragraph('D. 6')
            ]
        }]
    });
    return Packer.toBuffer(doc);
}

// .docx mà ĐÁP ÁN ĐÚNG ĐƯỢC GẠCH CHÂN (kiểu đề thi rất phổ biến khi in từ Word).
// Có 3 kiểu: gạch chân chỉ chữ cái ("D."), gạch chân cả dòng, và dòng câu hỏi
// bị gạch chân (KHÔNG được coi là đáp án).
async function buildUnderlinedDocx() {
    const under = (t) => new TextRun({ text: t, underline: {} });
    const doc = new Document({
        sections: [{
            children: [
                new Paragraph('Câu 1: Nội dung nào sau đây phản ánh không đúng đặc điểm của xu thế đa cực trong quan hệ quốc tế?'),
                new Paragraph('A. Mỹ suy giảm sức mạnh tương đối so với các cường quốc khác.'),
                new Paragraph('B. Sự gia tăng sức mạnh của các nước lớn.'),
                new Paragraph('C. Vai trò ngày càng tăng của các trung tâm quốc tế.'),
                // Gạch chân CHỈ chữ cái "D."
                new Paragraph({ children: [under('D.'), new TextRun(' Sự cạnh tranh sức mạnh tổng hợp.')] }),

                new Paragraph('Câu 2: Nội dung nào sau đây không phản ánh đúng bối cảnh lịch sử hình thành tổ chức Liên hợp quốc?'),
                new Paragraph('A. Nhân dân thế giới có khát vọng được chung sống hòa bình.'),
                // Gạch chân CHỈ chữ cái "B."
                new Paragraph({ children: [under('B.'), new TextRun(' Chủ nghĩa phát xít xuất hiện và cầm quyền ở nhiều nước.')] }),
                new Paragraph('C. Ý thức của các nước Đồng minh về việc tổ chức thế giới.'),
                new Paragraph('D. Nhu cầu thành lập tổ chức quốc tế mới thay thế tổ chức cũ.'),

                new Paragraph('Câu 3: Số nào sau đây là số nguyên tố?'),
                new Paragraph('A. 4'),
                new Paragraph('B. 6'),
                new Paragraph('C. 8'),
                // Gạch chân CẢ DÒNG đáp án
                new Paragraph({ children: [under('D. 11')] }),

                new Paragraph('Câu 4: Hành tinh nào nằm gần Mặt Trời nhất?'),
                new Paragraph('A. Sao Kim'),
                new Paragraph('B. Sao Thủy'),
                new Paragraph('C. Trái Đất'),
                new Paragraph('D. Sao Hỏa'),

                // Dòng CÂU HỎI bị gạch chân -> KHÔNG được suy ra thành đáp án
                new Paragraph({ children: [under('Câu 5: Dòng này gạch chân nhưng là dòng câu hỏi, không phải đáp án.')] }),
                new Paragraph('A. Phương án một.'),
                new Paragraph('B. Phương án hai.')
            ]
        }]
    });
    return Packer.toBuffer(doc);
}

// .docx mo phong de 2025 in 2 COT: nhieu dap an tren CUNG 1 dong (cach nhau
// bang khoang trang), "Câu N." in dam, dap an dung gach chan o CHU CAI, va
// PHAN II la cau dung/sai voi cac phat bieu a) b) c) d).
async function buildCompactTwoColumnDocx() {
    const bold = (t) => new TextRun({ text: t, bold: true });
    const under = (t) => new TextRun({ text: t, underline: {} });
    const gap = ' '.repeat(40);
    const doc = new Document({
        sections: [{
            children: [
                new Paragraph({ children: [bold('PHẦN I.'), new TextRun(' Câu trắc nghiệm nhiều phương án lựa chọn.')] }),

                new Paragraph({ children: [bold('Câu 1.'), new TextRun(' Năm 1967, quốc gia nào tham gia sáng lập ASEAN?')] }),
                // 2 dap an tren 1 dong, dap an dung (B) bi gach chan
                new Paragraph({ children: [new TextRun('A. Campuchia' + gap), under('B.'), new TextRun(' Mianma')] }),
                new Paragraph({ children: [new TextRun('C. Brunây' + gap + 'D. Malaixia')] }),

                new Paragraph({ children: [bold('Câu 2.'), new TextRun(' Cộng đồng ASEAN được xây dựng trên 3 trụ cột chính là chính trị - an ninh, văn hóa – xã hội và')] }),
                new Paragraph({ children: [new TextRun('A. tiền tệ' + gap + 'B. đối ngoại')] }),
                // dap an dung (C) nam trong dong bat dau bang C
                new Paragraph({ children: [under('C.'), new TextRun(' kinh tế' + gap + 'D. quân sự')] }),

                new Paragraph({ children: [bold('Câu 3.'), new TextRun(' Năm 1967, tổ chức nào được thành lập?')] }),
                // 4 dap an tren CUNG 1 dong, dap an dung (D) bi gach chan
                new Paragraph({ children: [new TextRun('A. Campuchia' + gap + 'B. Mianma' + gap + 'C. Brunây' + gap), under('D.'), new TextRun(' Malaixia')] }),

                new Paragraph({ children: [bold('PHẦN II.'), new TextRun(' Câu trắc nghiệm đúng sai. Trong mỗi ý a), b), c), d) thí sinh chọn đúng hoặc sai.')] }),
                new Paragraph({ children: [bold('Câu 1.'), new TextRun(' Cho đoạn tư liệu sau đây:')] }),
                new Paragraph('"Đại hội đồng Liên hợp quốc thông qua bản Tuyên ngôn về thủ tiêu hoàn toàn chủ nghĩa thực dân."'),
                // gach chan o a) va d) => hai phat bieu DUNG
                new Paragraph({ children: [under('a)'), new TextRun(' Tuyên ngôn khẳng định các nước thực dân đã vi phạm luật pháp quốc tế.')] }),
                new Paragraph({ children: [new TextRun('b) Liên hợp quốc duy trì hệ thống thuộc địa.')] }),
                new Paragraph({ children: [new TextRun('c) Tuyên ngôn tạo cơ sở pháp lý cho kháng chiến chống Pháp.')] }),
                new Paragraph({ children: [under('d)'), new TextRun(' Tuyên ngôn tác động sâu sắc đến phong trào giải phóng dân tộc.')] }),

                new Paragraph({ children: [bold('Câu 2.'), new TextRun(' Cho đoạn tư liệu sau đây:')] }),
                new Paragraph({ children: [new TextRun('a) Vai trò của Liên hợp quốc bị hạn chế bởi nguyên tắc tôn trọng chủ quyền.')] }),
                new Paragraph({ children: [under('b)'), new TextRun(' Liên hợp quốc thường xuyên dùng vũ lực để chấm dứt xung đột.')] }),
                new Paragraph({ children: [new TextRun('c) Việt Nam đã góp phần gìn giữ hòa bình và an ninh quốc tế.')] }),
                new Paragraph({ children: [new TextRun('d) Mọi tranh chấp trên thế giới đều đã được giải quyết.')] })
            ]
        }]
    });
    return Packer.toBuffer(doc);
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

// Gọi /api/import/preview với 1 file Word [{name, type, buffer}]
async function preview(cookie, files) {
    const f = files[0];
    const fd = new FormData();
    fd.append('file', blobOf(f.buffer, f.type), f.name);
    const res = await fetch(BASE + '/api/import/preview', {
        method: 'POST',
        headers: cookie ? { Cookie: cookie } : {},
        body: fd
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

async function confirm(cookie, payload) {
    const res = await fetch(BASE + '/api/import/confirm', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
        body: JSON.stringify(payload)
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

async function getExams(cookie) {
    const res = await fetch(BASE + '/api/exams', { headers: { Cookie: cookie } });
    return res.json();
}

// .docx co cau hoi nam trong Heading (Mammoth -> <h1>..<h6>) — dung kieu file
// "Sử-Trắc nghiệm.docx" tung lam mat 33/120 cau khi parser chi doc <p>.
async function buildHeadingDocx(total) {
    const children = [];
    for (let n = 1; n <= total; n++) {
        const level = n % 9 === 0 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1;
        const title = `Câu ${n}: Nội dung câu hỏi số ${n}?`;
        children.push(n % 3 === 0 ? new Paragraph({ text: title, heading: level }) : new Paragraph(title));
        for (let k = 0; k < 4; k++) {
            const letter = 'ABCD'[k];
            const star = (k === n % 4) ? ' *' : '';
            children.push(new Paragraph(`${letter}. Phương án ${letter} của câu ${n}${star}`));
        }
    }
    return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

// Cac truong hop bien: nhieu doan van, khoang trang, thieu/trung so thu tu,
// anh nhung, cau tra loi ngan, cau rong.
async function buildEdgeCaseDocx() {
    const children = [
        new Paragraph({ text: 'Câu 1: Câu hỏi trải trên', heading: HeadingLevel.HEADING_1 }),
        new Paragraph('nhiều đoạn văn (phần tiếp theo).'),
        new Paragraph('A. Một'),
        new Paragraph('B. Hai *'),
        new Paragraph('C. Ba'),
        new Paragraph('D. Bốn'),
        new Paragraph('   '),

        new Paragraph({ text: 'Câu 2:   Câu có khoảng trắng lớn   và bị ngắt trang.   ', heading: HeadingLevel.HEADING_3 }),
        new Paragraph('A. Một'),
        new Paragraph('B. Hai'),
        new Paragraph('C. Ba *'),
        new Paragraph('D. Bốn'),

        // Số 3 bị thiếu, số 4 bị trùng
        new Paragraph({ text: 'Câu 4: Câu trùng số thứ tự lần một?', heading: HeadingLevel.HEADING_2 }),
        new Paragraph('A. Một'),
        new Paragraph('B. Hai *'),
        new Paragraph('C. Ba'),
        new Paragraph('D. Bốn'),

        new Paragraph({ text: 'Câu 4: Câu trùng số thứ tự lần hai?', heading: HeadingLevel.HEADING_3 }),
        new Paragraph('A. Một *'),
        new Paragraph('B. Hai'),
        new Paragraph('C. Ba'),
        new Paragraph('D. Bốn'),

        new Paragraph({
            children: [
                new TextRun('Câu 6: Hình minh họa: '),
                new ImageRun({ type: 'png', data: PNG_1x1, transformation: { width: 10, height: 10 } })
            ]
        }),
        new Paragraph('A. Một'),
        new Paragraph('B. Hai'),
        new Paragraph('C. Ba *'),
        new Paragraph('D. Bốn'),

        new Paragraph('HẾT'),
        new Paragraph({ text: 'Phần III. Trắc nghiệm trả lời ngắn', heading: HeadingLevel.HEADING_1 }),
        new Paragraph('Câu 7: Số cần điền là bao nhiêu?'),
        new Paragraph('Đáp án: 42'),
        new Paragraph({ text: 'Câu 8:', heading: HeadingLevel.HEADING_1 }),
        new Paragraph('A. Một'),
        new Paragraph('B. Hai')
    ];
    return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

const createdExams = [];

(async function main() {
    let cookie;
    try {
        cookie = await login();
    } catch (e) {
        console.error('\nKhông đăng nhập được: ' + e.message);
        console.error('Hãy chắc chắn server đang chạy: PORT=3999 TEACHER_PASSWORD=test123 node server.js');
        process.exit(2);
    }

    // Ghi nhớ bài đang chọn để kiểm tra test không làm thay đổi nó
    const examsBeforeCurrent = (await getExams(cookie)).currentExamId;

    // ------------------------------------------------------------------
    console.log('\n=== 1. DOCX hợp lệ -> xem trước ===');
    const goodDocx = await buildSampleDocx();
    const p1 = await preview(cookie, [{
        name: 'de-thi.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: goodDocx
    }]);
    check('preview trả về success', p1.json && p1.json.success === true, JSON.stringify(p1.json).slice(0, 200));
    check('có sessionId', !!(p1.json && p1.json.sessionId));
    check('nhận diện 2 câu hỏi', p1.json && p1.json.count === 2, 'count=' + (p1.json && p1.json.count));

    const qs = (p1.json && p1.json.questions) || [];
    check('câu 1 là "single"', qs[0] && qs[0].type === 'single', JSON.stringify(qs[0] && qs[0].type));
    check('câu 1 có 4 đáp án', qs[0] && qs[0].options.length === 4, JSON.stringify(qs[0] && qs[0].options));
    check('câu 1 nhận đúng đáp án B (index 1)', qs[0] && qs[0].correct === 1, 'correct=' + (qs[0] && qs[0].correct));
    check('câu 1 không bị đánh dấu cần kiểm tra', qs[0] && qs[0].needsReview === false);

    // ------------------------------------------------------------------
    console.log('\n=== 2. Câu hỏi THIẾU ĐÁP ÁN -> đánh dấu, KHÔNG tự bịa ===');
    check('câu 2 được đánh dấu needsReview', qs[1] && qs[1].needsReview === true, JSON.stringify(qs[1]));
    check('câu 2 KHÔNG tự gán đáp án A (correct = null)', qs[1] && qs[1].correct === null, 'correct=' + (qs[1] && JSON.stringify(qs[1].correct)));
    check('câu 2 có lý do "chưa xác định được đáp án"',
        qs[1] && (qs[1].reviewReasons || []).join(' ').toLowerCase().indexOf('đáp án') >= 0,
        JSON.stringify(qs[1] && qs[1].reviewReasons));
    check('báo đúng số câu cần kiểm tra (1)', p1.json.needsReview === 1, 'needsReview=' + p1.json.needsReview);

    // ------------------------------------------------------------------
    console.log('\n=== 3. Xác nhận lưu: câu thiếu đáp án bị BỎ QUA, không lưu sai ===');
    const c1 = await confirm(cookie, {
        sessionId: p1.json.sessionId,
        destination: 'new',
        examName: 'TEST-IMPORT-DOCX',
        questions: qs.map(q => ({
            include: true, type: q.type, question: q.question, options: q.options,
            correct: q.correct, correctList: q.correctList, correctTF: q.correctTF
        }))
    });
    check('confirm thành công', c1.json && c1.json.success === true, JSON.stringify(c1.json).slice(0, 200));
    check('lưu đúng 1 câu hợp lệ', c1.json && c1.json.saved === 1, 'saved=' + (c1.json && c1.json.saved));
    check('bỏ qua 1 câu thiếu đáp án', c1.json && c1.json.skipped && c1.json.skipped.length === 1, JSON.stringify(c1.json && c1.json.skipped));
    if (c1.json && c1.json.examId) createdExams.push(c1.json.examId);

    const list1 = await getExams(cookie);
    const savedExam = (list1.exams || []).find(e => e.id === c1.json.examId);
    check('bài mới có đúng 1 câu hỏi trong file lưu', savedExam && savedExam.questionCount === 1,
        JSON.stringify(savedExam));

    // ------------------------------------------------------------------
    console.log('\n=== 4. Phiên đã dùng -> không lưu lại được (chống lặp) ===');
    const c1again = await confirm(cookie, {
        sessionId: p1.json.sessionId,
        destination: 'current',
        questions: qs.map(q => ({ include: true, type: q.type, question: q.question, options: q.options, correct: 1 }))
    });
    check('confirm lại cùng phiên bị từ chối', c1again.json && c1again.json.success === false,
        JSON.stringify(c1again.json).slice(0, 160));

    // ------------------------------------------------------------------
    console.log('\n=== 5. File SAI ĐỊNH DẠNG ===');
    const wrongExt = await preview(cookie, [{ name: 'de-thi.txt', type: 'text/plain', buffer: Buffer.from('hello') }]);
    check('.txt bị từ chối (400)', wrongExt.status === 400, 'status=' + wrongExt.status);
    check('.txt có thông báo rõ ràng',
        wrongExt.json && /Word|docx/i.test(wrongExt.json.error || ''), JSON.stringify(wrongExt.json));

    const fakeDocx = await preview(cookie, [{
        name: 'gia-danh.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from('Đây chỉ là văn bản thường, không phải file Word thật.')
    }]);
    check('file .docx giả (sai nội dung) bị từ chối', fakeDocx.json && fakeDocx.json.success === false, JSON.stringify(fakeDocx.json).slice(0, 200));
    check('báo rõ không phải .docx hợp lệ',
        fakeDocx.json && /docx/i.test(fakeDocx.json.error || ''), JSON.stringify(fakeDocx.json));

    // ------------------------------------------------------------------
    console.log('\n=== 6. LỖI ĐỌC FILE (docx hỏng) -> báo lỗi, không sập ===');
    const corrupt = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.alloc(300, 0x41)]);
    const badRead = await preview(cookie, [{
        name: 'hong.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: corrupt
    }]);
    check('docx hỏng -> success=false (không sập server)', badRead.json && badRead.json.success === false, JSON.stringify(badRead.json).slice(0, 200));
    check('có thông báo lỗi đọc file',
        badRead.json && /không thể đọc file/i.test(badRead.json.error || ''), JSON.stringify(badRead.json));

    // ------------------------------------------------------------------
    console.log('\n=== 7. Ảnh rời bị từ chối (đã gỡ import ảnh/OCR) ===');
    const imgPreview = await preview(cookie, [{ name: 'hinh-1.png', type: 'image/png', buffer: PNG_1x1 }]);
    check('ảnh -> bị từ chối (400)', imgPreview.status === 400, 'status=' + imgPreview.status);
    check('báo chỉ nhận file Word',
        imgPreview.json && /Word/i.test(imgPreview.json.error || ''), JSON.stringify(imgPreview.json));

    // ------------------------------------------------------------------
    console.log('\n=== 8. Không còn endpoint OCR ===');
    const ocrExtract = await fetch(BASE + '/api/ocr/extract', { method: 'POST', headers: { Cookie: cookie } });
    const ocrAnalyze = await fetch(BASE + '/api/ocr/analyze', { method: 'POST', headers: { Cookie: cookie } });
    const ocrStatus = await fetch(BASE + '/api/ocr/status', { headers: { Cookie: cookie } });
    check('/api/ocr/extract -> 404', ocrExtract.status === 404, 'status=' + ocrExtract.status);
    check('/api/ocr/analyze -> 404', ocrAnalyze.status === 404, 'status=' + ocrAnalyze.status);
    check('/api/ocr/status -> 404', ocrStatus.status === 404, 'status=' + ocrStatus.status);

    // ------------------------------------------------------------------
    console.log('\n=== 9. File quá dung lượng -> bị chặn ===');
    const big = Buffer.alloc(16 * 1024 * 1024, 0x41); // 16 MB > 15 MB
    const tooBig = await preview(cookie, [{
        name: 'qua-lon.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: big
    }]);
    check('file 16MB bị từ chối (400)', tooBig.status === 400, 'status=' + tooBig.status);
    check('thông báo quá dung lượng',
        tooBig.json && /quá lớn/i.test(tooBig.json.error || ''), JSON.stringify(tooBig.json));

    // ------------------------------------------------------------------
    console.log('\n=== 10. Bảo vệ: chưa đăng nhập không dùng được ===');
    const anon = await preview(null, [{ name: 'de-thi.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: goodDocx }]);
    check('preview khi chưa đăng nhập -> 403', anon.status === 403, 'status=' + anon.status);

    const anonConfirm = await confirm(null, { sessionId: 'x', questions: [{ type: 'single', question: 'a', options: ['1', '2'], correct: 0 }] });
    check('confirm khi chưa đăng nhập -> 403', anonConfirm.status === 403, 'status=' + anonConfirm.status);

    // Trang giáo viên phải chặn cả khi đường dẫn bị "ngụy trang"
    // (//teacher.html, /%74eacher.html...). Trước đây các dạng này LỌT QUA guard
    // rồi được express.static trả về nguyên trang giáo viên.
    for (const p of ['/teacher.html', '//teacher.html', '/%74eacher.html', '/./teacher.html']) {
        const r = await fetch(BASE + p, { redirect: 'manual' });
        const guarded = r.status === 302 || r.status === 301 || r.status === 403;
        let body = '';
        if (!guarded) { try { body = await r.text(); } catch (e) { /* ignore */ } }
        check('chưa đăng nhập, "' + p + '" -> bị chặn (không trả trang giáo viên)',
            guarded && !/Quản lý Bài kiểm tra/.test(body), 'status=' + r.status + ' len=' + body.length);
    }
    const okTeacher = await fetch(BASE + '/teacher.html', { headers: { Cookie: cookie } });
    const okBody = okTeacher.ok ? await okTeacher.text() : '';
    check('giáo viên ĐÃ đăng nhập vẫn mở được trang giáo viên',
        okTeacher.status === 200 && /Quản lý Bài kiểm tra/.test(okBody), 'status=' + okTeacher.status + ' len=' + okBody.length);

    // ------------------------------------------------------------------
    console.log('\n=== 11. Word: đáp án đúng được GẠCH CHÂN (không dùng dấu *) ===');
    const ulDocx = await buildUnderlinedDocx();
    const pu = await preview(cookie, [{
        name: 'de-thi-gach-chan.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: ulDocx
    }]);
    check('preview docx gạch chân -> success', pu.json && pu.json.success === true, JSON.stringify(pu.json).slice(0, 200));
    check('nhận diện 5 câu hỏi', pu.json && pu.json.count === 5, 'count=' + (pu.json && pu.json.count));

    const uq = (pu.json && pu.json.questions) || [];
    check('gạch chân CHỮ CÁI -> đáp án D (index 3)', uq[0] && uq[0].correct === 3, 'correct=' + (uq[0] && JSON.stringify(uq[0].correct)));
    check('gạch chân CHỮ CÁI -> đáp án B (index 1)', uq[1] && uq[1].correct === 1, 'correct=' + (uq[1] && JSON.stringify(uq[1].correct)));
    check('gạch chân CẢ DÒNG -> đáp án D (index 3)', uq[2] && uq[2].correct === 3, 'correct=' + (uq[2] && JSON.stringify(uq[2].correct)));
    check('câu có gạch chân KHÔNG bị đánh dấu cần kiểm tra', uq[0] && uq[0].needsReview === false, JSON.stringify(uq[0] && uq[0].needsReview));
    check('KHÔNG gạch chân -> correct = null (không tự bịa)', uq[3] && uq[3].correct === null, 'correct=' + (uq[3] && JSON.stringify(uq[3].correct)));
    check('KHÔNG gạch chân -> đánh dấu cần kiểm tra', uq[3] && uq[3].needsReview === true);
    check('gạch chân ở DÒNG CÂU HỎI không bị coi là đáp án', uq[4] && uq[4].correct === null, 'correct=' + (uq[4] && JSON.stringify(uq[4].correct)));

    const uOpt0 = String((uq[0] && uq[0].options[3]) || '');
    const uText0 = uOpt0.replace(/<[^>]+>/g, '').trim();
    check('đáp án gạch chân đã bỏ thẻ <u>', !/<u\b/i.test(uOpt0), JSON.stringify(uOpt0));
    check('đáp án gạch chân đã bỏ chữ cái "D." ở đầu', !/^D\./.test(uText0), JSON.stringify(uText0));
    check('đáp án gạch chân giữ đúng nội dung',
        /cạnh tranh sức mạnh tổng hợp/i.test(uText0), JSON.stringify(uText0));
    const uText3 = String((uq[2] && uq[2].options[3]) || '').replace(/<[^>]+>/g, '').trim();
    check('câu gạch chân CẢ DÒNG cũng sạch chữ cái đầu', uText3 === '11', JSON.stringify(uText3));

    // Lưu thật rồi đọc lại
    const cu = await confirm(cookie, {
        sessionId: pu.json.sessionId,
        destination: 'new',
        examName: 'TEST-IMPORT-UNDERLINE',
        questions: uq.map(q => ({
            include: true, type: q.type, question: q.question, options: q.options,
            correct: q.correct, correctList: q.correctList, correctTF: q.correctTF
        }))
    });
    check('lưu 3 câu có đáp án (bỏ 2 câu thiếu đáp án)',
        cu.json && cu.json.success === true && cu.json.saved === 3, JSON.stringify(cu.json).slice(0, 200));
    if (cu.json && cu.json.examId) createdExams.push(cu.json.examId);

    if (cu.json && cu.json.examId) {
        const ulRe = await fetch(BASE + '/api/exams/' + cu.json.examId, { headers: { Cookie: cookie } });
        const ulJson = await ulRe.json();
        const savedU = (ulJson && ulJson.exam && ulJson.exam.questions) || [];
        check('đọc lại được 3 câu đã lưu', savedU.length === 3, 'len=' + savedU.length);
        check('đáp án gạch chân được LƯU đúng (D)', savedU[0] && savedU[0].correct === 3, JSON.stringify(savedU[0] && savedU[0].correct));
        check('đáp án gạch chân được LƯU đúng (B)', savedU[1] && savedU[1].correct === 1, JSON.stringify(savedU[1] && savedU[1].correct));
        check('đáp án gạch chân được LƯU đúng (câu 3 = D)',
            savedU[2] && savedU[2].correct === 3, JSON.stringify(savedU[2] && savedU[2].correct));
    }

    // ------------------------------------------------------------------
    console.log('\n=== 12. Word: đề in 2 cột (nhiều đáp án 1 dòng) + "Câu N." in đậm + Phần II đúng/sai ===');
    // Mo phong dung kieu file giao vien gui: Word trinh bay 2 cot bang khoang
    // trang nen 1 doan co 2 (hoac 4) dap an; "Câu N." bi in dam; dap an dung
    // gach chan o chu cai; Phan II la cau dung/sai voi a) b) c) d).
    const compactDocx = await buildCompactTwoColumnDocx();
    const pc = await preview(cookie, [{
        name: 'de-2-cot.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: compactDocx
    }]);
    check('đề 2 cột -> preview success', pc.json && pc.json.success === true, JSON.stringify(pc.json).slice(0, 200));
    check('nhận diện 5 câu (3 trắc nghiệm + 2 đúng/sai)', pc.json && pc.json.count === 5, 'count=' + (pc.json && pc.json.count));

    const cq = (pc.json && pc.json.questions) || [];
    const cText = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim();

    // Loi giao vien bao: "cau 71 long cau 80" = tien to "Câu N." con nam trong
    // noi dung cau hoi (vi no bi in dam nen regex cu khong khop).
    check('bỏ được tiền tố "Câu N." in đậm ở đầu câu hỏi',
        cq[0] && !/^Câu\s*\d/i.test(cText(cq[0].question)), JSON.stringify(cText(cq[0] && cq[0].question).slice(0, 60)));
    check('nội dung câu hỏi không còn thẻ HTML hiện ra chữ (no <strong>)',
        cq.every(q => !/<\/?[a-z]/i.test(String(q.question))), JSON.stringify(String(cq[0] && cq[0].question).slice(0, 90)));
    check('đáp án không còn thẻ HTML hiện ra chữ',
        cq.every(q => (q.options || []).every(o => !/<\/?[a-z]/i.test(String(o)))));

    // Tach 2 dap an tren cung 1 dong: "A. ... B. ..." (dap an dung la B)
    check('tách được 2 đáp án cùng dòng thành 4 đáp án',
        cq[0] && cq[0].options.length === 4, 'len=' + (cq[0] && cq[0].options.length));
    check('nội dung đáp án A sạch (không dính "B.")',
        cText(cq[0] && cq[0].options[0]) === 'Campuchia', JSON.stringify(cText(cq[0] && cq[0].options[0])));
    check('nội dung đáp án B sạch (không dính chữ cái "B.")',
        cText(cq[0] && cq[0].options[1]) === 'Mianma', JSON.stringify(cText(cq[0] && cq[0].options[1])));
    check('không còn khoảng trắng cột trong đáp án',
        cq.every(q => (q.options || []).every(o => !/\s{2,}/.test(cText(o)))));

    // Dap an dung gach chan nam trong DONG co nhieu dap an -> phai gan dung
    // (truoc day gach chan o B/C bi tinh cho dap an dau dong).
    check('gạch chân ở B (dòng có A,B) -> đáp án B', cq[0] && cq[0].correct === 1, 'correct=' + (cq[0] && JSON.stringify(cq[0].correct)));
    check('gạch chân ở C (dòng có C,D) -> đáp án C', cq[1] && cq[1].correct === 2, 'correct=' + (cq[1] && JSON.stringify(cq[1].correct)));
    check('gạch chân ở D (dòng có đủ A,B,C,D) -> đáp án D', cq[2] && cq[2].correct === 3, 'correct=' + (cq[2] && JSON.stringify(cq[2].correct)));

    // "Phần II. Câu trắc nghiệm đúng sai." -> các câu sau là đúng/sai, và gạch
    // chân dưới phát biểu = phát biểu ĐÚNG.
    check('Phần II -> câu 4 là loại đúng/sai', cq[3] && cq[3].type === 'truefalse', JSON.stringify(cq[3] && cq[3].type));
    check('Phần II -> câu 5 là loại đúng/sai', cq[4] && cq[4].type === 'truefalse', JSON.stringify(cq[4] && cq[4].type));
    check('Phần II câu 4: gạch chân a) và d) -> Đúng/Sai = T,F,F,T',
        cq[3] && JSON.stringify(cq[3].correctTF) === JSON.stringify([true, false, false, true]), JSON.stringify(cq[3] && cq[3].correctTF));
    check('Phần II câu 5: gạch chân b) -> Đúng/Sai = F,T,F,F',
        cq[4] && JSON.stringify(cq[4].correctTF) === JSON.stringify([false, true, false, false]), JSON.stringify(cq[4] && cq[4].correctTF));
    check('tiêu đề "Phần II" KHÔNG tạo lý do "cần kiểm tra" giả',
        cq.every(q => (q.reviewReasons || []).every(r => !/chưa nhận dạng được/i.test(r))),
        JSON.stringify(cq.map(q => q.reviewReasons || [])));
    check('đề 2 cột: không câu nào bị đánh dấu cần kiểm tra',
        pc.json && pc.json.needsReview === 0 && cq.every(q => q.needsReview === false),
        'needsReview=' + (pc.json && pc.json.needsReview));

    // Lưu thật rồi đọc lại (cả câu đúng/sai)
    const cc = await confirm(cookie, {
        sessionId: pc.json.sessionId,
        destination: 'new',
        examName: 'TEST-IMPORT-2COT',
        questions: cq.map(q => ({
            include: true, type: q.type, question: q.question, options: q.options,
            correct: q.correct, correctList: q.correctList, correctTF: q.correctTF
        }))
    });
    check('lưu được cả 5 câu (3 trắc nghiệm + 2 đúng/sai)',
        cc.json && cc.json.success === true && cc.json.saved === 5, JSON.stringify(cc.json).slice(0, 200));
    if (cc.json && cc.json.examId) createdExams.push(cc.json.examId);
    if (cc.json && cc.json.examId) {
        const cRe = await fetch(BASE + '/api/exams/' + cc.json.examId, { headers: { Cookie: cookie } });
        const cJson = await cRe.json();
        const savedC = (cJson && cJson.exam && cJson.exam.questions) || [];
        check('đọc lại được 5 câu đã lưu', savedC.length === 5, 'len=' + savedC.length);
        check('câu 1 lưu đáp án đúng B', savedC[0] && savedC[0].correct === 1, JSON.stringify(savedC[0] && savedC[0].correct));
        check('câu 4 lưu đúng loại đúng/sai + Đ/S',
            savedC[3] && savedC[3].type === 'truefalse' &&
            JSON.stringify(savedC[3].correctTF) === JSON.stringify([true, false, false, true]),
            JSON.stringify(savedC[3] && savedC[3].correctTF));
    }

    // ------------------------------------------------------------------
    console.log('\n=== 13. Word: câu hỏi nằm trong Heading 1/2 + đánh số 1..120 ===');
    // File thật "Sử-Trắc nghiệm.docx" đặt nhiều câu trong Heading 1. Parser cũ
    // chỉ đọc <p> nên bỏ qua đúng 33 câu (3, 8-10, 12, ... 119).
    const headingDocx = await buildHeadingDocx(120);
    const ph = await preview(cookie, [{
        name: 'de-heading-120.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: headingDocx
    }]);
    check('đề Heading -> preview success', ph.json && ph.json.success === true, JSON.stringify(ph.json).slice(0, 200));
    check('nhận diện đủ 120 câu (không mất câu trong heading)',
        ph.json && ph.json.count === 120, 'count=' + (ph.json && ph.json.count));

    const hq = (ph.json && ph.json.questions) || [];
    check('đủ và đúng thứ tự số câu 1..120',
        hq.length === 120 && hq.every((q, i) => q.importNumber === i + 1),
        JSON.stringify(hq.map(q => q.importNumber).filter((n, i) => n !== i + 1)));

    const hc = (ph.json && ph.json.completeness) || {};
    check('completeness: detected = 120', hc.detected === 120, 'detected=' + hc.detected);
    check('completeness: không thiếu số thứ tự', (hc.missingNumbers || []).length === 0, JSON.stringify(hc.missingNumbers));
    check('completeness: không trùng số thứ tự', (hc.duplicateNumbers || []).length === 0, JSON.stringify(hc.duplicateNumbers));
    check('completeness: không câu rỗng', (hc.emptyQuestions || []).length === 0, JSON.stringify(hc.emptyQuestions));
    check('completeness: không câu thiếu phương án', (hc.missingOptions || []).length === 0, JSON.stringify(hc.missingOptions));

    check('câu 3 (heading): bỏ tiền tố "Câu 3:"',
        hq[2] && !/^Câu\s*\d/i.test(String(hq[2].question)), JSON.stringify(hq[2] && hq[2].question));
    check('câu 3 (heading): có 4 phương án + đáp án D',
        hq[2] && hq[2].options.length === 4 && hq[2].correct === 3,
        JSON.stringify(hq[2] && { opts: hq[2].options.length, correct: hq[2].correct }));
    check('câu 100 đánh số 3 chữ số vẫn nhận đúng',
        hq[99] && hq[99].importNumber === 100 && /Nội dung câu hỏi số 100/.test(hq[99].question),
        JSON.stringify(hq[99] && hq[99].question));

    const hcSave = await confirm(cookie, {
        sessionId: ph.json.sessionId,
        destination: 'new',
        examName: 'TEST-IMPORT-HEADING-120',
        questions: hq.map(q => ({
            include: true, type: q.type, question: q.question, options: q.options,
            correct: q.correct, correctList: q.correctList, correctTF: q.correctTF
        }))
    });
    check('lưu đủ 120 câu', hcSave.json && hcSave.json.success === true && hcSave.json.saved === 120,
        JSON.stringify(hcSave.json).slice(0, 200));
    check('confirm báo đối chiếu đầy đủ (received = saved + skipped)',
        hcSave.json && hcSave.json.complete === true && hcSave.json.received === 120,
        JSON.stringify(hcSave.json && { received: hcSave.json.received, complete: hcSave.json.complete }));
    if (hcSave.json && hcSave.json.examId) createdExams.push(hcSave.json.examId);
    if (hcSave.json && hcSave.json.examId) {
        const hRe = await fetch(BASE + '/api/exams/' + hcSave.json.examId, { headers: { Cookie: cookie } });
        const hJson = await hRe.json();
        const savedH = (hJson && hJson.exam && hJson.exam.questions) || [];
        check('đọc lại từ file lưu: đúng 120 câu', savedH.length === 120, 'len=' + savedH.length);
        check('câu 120 lưu đúng nội dung',
            savedH[119] && /Nội dung câu hỏi số 120/.test(savedH[119].question),
            JSON.stringify(savedH[119] && savedH[119].question));
    }

    // ------------------------------------------------------------------
    console.log('\n=== 14. Word: nhiều đoạn văn, thiếu/trùng số, ảnh, trả lời ngắn ===');
    const edgeDocx = await buildEdgeCaseDocx();
    const pe = await preview(cookie, [{
        name: 'de-bien.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: edgeDocx
    }]);
    check('đề biên -> preview success', pe.json && pe.json.success === true, JSON.stringify(pe.json).slice(0, 200));
    const eq = (pe.json && pe.json.questions) || [];
    const ec = (pe.json && pe.json.completeness) || {};
    check('nhận diện 7 câu (gồm câu trả lời ngắn + câu rỗng)', eq.length === 7, 'len=' + eq.length);

    const eqText = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim();
    check('câu hỏi nối được đoạn văn tiếp theo',
        /nhiều đoạn văn \(phần tiếp theo\)/i.test(eqText(eq[0] && eq[0].question)),
        JSON.stringify(eqText(eq[0] && eq[0].question)));
    check('câu có khoảng trắng lớn / ngắt trang vẫn nhận đúng số 2',
        eq[1] && eq[1].importNumber === 2, JSON.stringify(eq[1] && eq[1].importNumber));
    check('completeness: báo thiếu số 3 và 5',
        (ec.missingNumbers || []).indexOf(3) >= 0 && (ec.missingNumbers || []).indexOf(5) >= 0,
        JSON.stringify(ec.missingNumbers));
    check('completeness: báo trùng số 4', (ec.duplicateNumbers || []).indexOf(4) >= 0,
        JSON.stringify(ec.duplicateNumbers));
    check('completeness: báo câu rỗng "Câu 8"',
        (ec.emptyQuestions || []).indexOf('Câu 8') >= 0, JSON.stringify(ec.emptyQuestions));
    check('completeness: đếm được ảnh nhúng (1) và không có ảnh lỗi',
        ec.imageCount === 1 && (ec.unresolvedImages || []).length === 0,
        JSON.stringify({ count: ec.imageCount, bad: ec.unresolvedImages }));
    const imgQ = eq.find(q => q.importNumber === 6) || {};
    check('câu có hình ảnh giữ được token ảnh', /\[\[IMG:\d+\]\]/.test(imgQ.question || ''), JSON.stringify(imgQ.question));
    check('câu trả lời ngắn nhận đúng loại + đáp án',
        eq.some(q => q.type === 'shortanswer' && q.correctAnswer === '42'),
        JSON.stringify(eq.filter(q => q.type === 'shortanswer').map(q => q.correctAnswer)));

    // ------------------------------------------------------------------
    console.log('\n=== 15. Dọn dẹp: xoá các bài test đã tạo ===');
    let cleaned = 0;
    for (const id of createdExams) {
        const r = await fetch(BASE + '/api/exams/' + id, { method: 'DELETE', headers: { Cookie: cookie } });
        let j = null;
        try { j = await r.json(); } catch (e) { /* ignore */ }
        if (j && j.success === true) cleaned++;
    }
    check('đã xoá các bài test tạo ra', cleaned === createdExams.length, cleaned + '/' + createdExams.length);

    const after = await getExams(cookie);
    check('bài đang chọn KHÔNG bị thay đổi bởi test',
        after.currentExamId === examsBeforeCurrent,
        'sau=' + after.currentExamId + ' truoc=' + examsBeforeCurrent);

    // ------------------------------------------------------------------
    console.log('\n=== 16. Giới hạn số phiên nhập đề giữ trong RAM ===');
    importSessions.clearAll();
    for (let i = 0; i < 30; i++) importSessions.create({ pool: {} });
    check('số phiên không vượt trần 20', importSessions.count() <= 20, 'count=' + importSessions.count());
    check('vẫn dùng được phiên mới nhất',
        (function () { const id = importSessions.create({ pool: {} }); return !!importSessions.get(id); })(),
        'phiên mới không đọc lại được');
    importSessions.clearAll();

    console.log('\n----------------------------------------');
    console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})().catch(function (err) {
    console.error('\nLỗi không mong đợi: ' + (err && err.stack ? err.stack : err));
    process.exit(2);
});
