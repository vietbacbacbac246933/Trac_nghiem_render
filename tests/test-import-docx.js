'use strict';
/**
 * Test cho tính năng "Nhập đề thi từ Word (.docx) và ảnh".
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
const { Document, Packer, Paragraph } = require(path.join(ROOT, 'node_modules', 'docx'));

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

// Gọi /api/import/preview với danh sách file [{name, type, buffer}]
async function preview(cookie, files) {
    const fd = new FormData();
    files.forEach(f => fd.append('files', blobOf(f.buffer, f.type), f.name));
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
        wrongExt.json && /không hỗ trợ/i.test(wrongExt.json.error || ''), JSON.stringify(wrongExt.json));

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
    console.log('\n=== 7. Ảnh: tạo câu giữ chỗ, ĐÁNH DẤU cần kiểm tra, giữ ảnh ===');
    const imgPreview = await preview(cookie, [{ name: 'hinh-1.png', type: 'image/png', buffer: PNG_1x1 }]);
    check('ảnh -> preview success', imgPreview.json && imgPreview.json.success === true, JSON.stringify(imgPreview.json).slice(0, 200));
    check('ảnh -> tạo 1 câu', imgPreview.json && imgPreview.json.count === 1, 'count=' + (imgPreview.json && imgPreview.json.count));
    const iq = (imgPreview.json && imgPreview.json.questions && imgPreview.json.questions[0]) || {};
    check('câu từ ảnh được đánh dấu cần kiểm tra', iq.needsReview === true, JSON.stringify(iq));
    check('câu từ ảnh chứa token ảnh', /\[\[IMG:\d+\]\]/.test(iq.question || ''), JSON.stringify(iq.question));
    check('có imagePool chứa ảnh gốc',
        imgPreview.json && imgPreview.json.imagePool && Object.keys(imgPreview.json.imagePool).length === 1);

    // ------------------------------------------------------------------
    console.log('\n=== 8. Ảnh chưa nhập nội dung -> KHÔNG lưu (không bịa) ===');
    const c2 = await confirm(cookie, {
        sessionId: imgPreview.json.sessionId,
        destination: 'new',
        examName: 'TEST-IMPORT-IMAGE-EMPTY',
        questions: [{ include: true, type: 'single', question: iq.question, options: [], correct: null }]
    });
    check('chưa nhập đáp án -> không lưu câu nào', c2.json && c2.json.success === false, JSON.stringify(c2.json).slice(0, 200));
    check('nêu rõ lý do bỏ qua',
        c2.json && c2.json.skipped && /đáp án/i.test(c2.json.skipped[0].reason || ''),
        JSON.stringify(c2.json && c2.json.skipped));

    // ------------------------------------------------------------------
    console.log('\n=== 9. Ảnh sau khi giáo viên bổ sung -> lưu và GIỮ ẢNH ===');
    const c3 = await confirm(cookie, {
        sessionId: imgPreview.json.sessionId,
        destination: 'new',
        examName: 'TEST-IMPORT-IMAGE-OK',
        questions: [{
            include: true, type: 'single',
            question: 'Hình dưới đây minh hoạ gì? [[IMG:0]]',
            options: ['Hình vuông', 'Hình tròn'],
            correct: 0
        }]
    });
    check('lưu được câu từ ảnh', c3.json && c3.json.success === true && c3.json.saved === 1, JSON.stringify(c3.json).slice(0, 200));
    if (c3.json && c3.json.examId) createdExams.push(c3.json.examId);

    let storedQuestion = null;
    if (c3.json && c3.json.examId) {
        // Đọc lại bài đã lưu (chỉ đọc, KHÔNG đổi bài đang dùng)
        const exRes = await fetch(BASE + '/api/exams/' + c3.json.examId, { headers: { Cookie: cookie } });
        const exJson = await exRes.json();
        storedQuestion = (exJson && exJson.exam && exJson.exam.questions) ? exJson.exam.questions[0] : null;
    }
    check('câu đã lưu có chứa ảnh base64 thật',
        storedQuestion && /<img[^>]+src="data:image\/png;base64,/i.test(storedQuestion.question || ''),
        JSON.stringify(storedQuestion && storedQuestion.question).slice(0, 160));
    check('token ảnh đã được thay hết (không còn [[IMG:)',
        storedQuestion && !/\[\[IMG:\d+\]\]/.test(storedQuestion.question || ''),
        JSON.stringify(storedQuestion && storedQuestion.question).slice(0, 160));

    // ------------------------------------------------------------------
    console.log('\n=== 10. File quá dung lượng -> bị chặn ===');
    const big = Buffer.alloc(16 * 1024 * 1024, 0x41); // 16 MB > 15 MB
    const tooBig = await preview(cookie, [{
        name: 'qua-lon.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: big
    }]);
    check('file 16MB bị từ chối (400)', tooBig.status === 400, 'status=' + tooBig.status);
    check('thông báo quá dung lượng',
        tooBig.json && /quá lớn/i.test(tooBig.json.error || ''), JSON.stringify(tooBig.json));

    // ------------------------------------------------------------------
    console.log('\n=== 11. Bảo vệ: chưa đăng nhập không dùng được ===');
    const anon = await preview(null, [{ name: 'de-thi.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: goodDocx }]);
    check('preview khi chưa đăng nhập -> 403', anon.status === 403, 'status=' + anon.status);

    const anonConfirm = await confirm(null, { sessionId: 'x', questions: [{ type: 'single', question: 'a', options: ['1', '2'], correct: 0 }] });
    check('confirm khi chưa đăng nhập -> 403', anonConfirm.status === 403, 'status=' + anonConfirm.status);

    // ------------------------------------------------------------------
    console.log('\n=== 12. Dọn dẹp: xoá các bài test đã tạo ===');
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

    console.log('\n----------------------------------------');
    console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})().catch(function (err) {
    console.error('\nLỗi không mong đợi: ' + (err && err.stack ? err.stack : err));
    process.exit(2);
});
