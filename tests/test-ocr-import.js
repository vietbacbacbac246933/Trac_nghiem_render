'use strict';
/**
 * Test cho tính năng "Nhập đề thi từ ẢNH bằng OCR".
 *
 * Yêu cầu: server đang chạy ở cổng 3999 với TEACHER_PASSWORD=test123.
 *   PowerShell (cửa sổ 1):
 *     $env:PORT='3999'; $env:TEACHER_PASSWORD='test123'; node server.js
 *   PowerShell (cửa sổ 2):
 *     node tests/test-ocr-import.js
 *
 * Có thể đổi bằng biến môi trường TEST_BASE (mặc định http://127.0.0.1:3999).
 * Ảnh mẫu nằm trong tests/fixtures/ (tạo lại bằng tests/fixtures/make-fixtures.ps1).
 *
 * Dùng fetch + FormData/Blob có sẵn trong Node >= 18 nên KHÔNG cần cài thêm gì.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3999';
const PASSWORD = process.env.TEST_PASSWORD || 'test123';

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('  PASS  ' + name); }
    else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function fixture(name) { return fs.readFileSync(path.join(FIX, name)); }
function blobOf(buffer, type) { return new Blob([buffer], { type }); }

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

// B1: upload + OCR
async function extract(cookie, files) {
    const fd = new FormData();
    files.forEach(f => fd.append('files', blobOf(f.buffer, f.type), f.name));
    const res = await fetch(BASE + '/api/ocr/extract', {
        method: 'POST',
        headers: cookie ? { Cookie: cookie } : {},
        body: fd
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

// B2: phân tích -> xem trước
async function analyze(cookie, sessionId) {
    const res = await fetch(BASE + '/api/ocr/analyze', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
        body: JSON.stringify({ sessionId })
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

async function getExam(cookie, id) {
    const res = await fetch(BASE + '/api/exams/' + id, { headers: { Cookie: cookie } });
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

function toSavePayload(q, extra) {
    return Object.assign({
        include: true,
        type: q.type,
        question: q.question,
        options: q.options,
        correct: q.correct,
        correctList: q.correctList,
        correctTF: q.correctTF,
        points: q.points
    }, extra || {});
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

    const examsBefore = await getExams(cookie);
    const examsBeforeCount = (examsBefore.exams || []).length;
    const currentBefore = examsBefore.currentExamId;

    // ------------------------------------------------------------------
    console.log('\n=== 1. Trạng thái OCR ===');
    const st = await fetch(BASE + '/api/ocr/status', { headers: { Cookie: cookie } });
    const stJson = await st.json();
    check('status trả về success', stJson && stJson.success === true, JSON.stringify(stJson).slice(0, 200));
    check('có nhà cung cấp OCR', !!(stJson.ocr && stJson.ocr.provider), JSON.stringify(stJson.ocr));
    check('có ngôn ngữ tiếng Việt', !!(stJson.ocr && (stJson.ocr.langs || []).indexOf('vie') >= 0), JSON.stringify(stJson.ocr && stJson.ocr.langs));
    console.log('       provider = ' + (stJson.ocr && stJson.ocr.provider));
    console.log('       langs    = ' + ((stJson.ocr && stJson.ocr.langs) || []).join('+'));

    // ------------------------------------------------------------------
    console.log('\n=== 2. Ảnh RÕ CHỮ, đủ câu hỏi + lựa chọn ===');
    const ex1 = await extract(cookie, [{ name: 'de-thi-4cau.png', type: 'image/png', buffer: fixture('de-thi-4cau.png') }]);
    check('extract thành công', ex1.json && ex1.json.success === true, JSON.stringify(ex1.json).slice(0, 200));
    check('trả về sessionId', !!(ex1.json && ex1.json.sessionId));
    check('đọc được chữ (chars > 0)', ex1.json && ex1.json.chars > 0, 'chars=' + (ex1.json && ex1.json.chars));
    check('có văn bản OCR để giáo viên đối chiếu', !!(ex1.json && ex1.json.text && ex1.json.text.length > 50));

    const an1 = await analyze(cookie, ex1.json.sessionId);
    check('analyze thành công', an1.json && an1.json.success === true, JSON.stringify(an1.json).slice(0, 200));
    check('tách đúng 4 câu hỏi', an1.json && an1.json.count === 4, 'count=' + (an1.json && an1.json.count));

    const q1 = (an1.json.questions || []);
    check('mọi câu đều là "single"', q1.length > 0 && q1.every(q => q.type === 'single'));
    check('mỗi câu có 4 đáp án', q1.length > 0 && q1.every(q => Array.isArray(q.options) && q.options.length === 4),
        JSON.stringify(q1.map(q => (q.options || []).length)));
    check('nội dung câu 1 khớp ảnh', q1[0] && /Thủ đô/.test(q1[0].question || ''), JSON.stringify(q1[0] && q1[0].question));
    check('đáp án câu 1 khớp ảnh (Hà Nội)', q1[0] && /Hà N/i.test(q1[0].options[1] || ''), JSON.stringify(q1[0] && q1[0].options));

    // ------------------------------------------------------------------
    console.log('\n=== 3. Đáp án đúng suy ra từ dấu * trong ảnh (không bịa) ===');
    check('câu 1: đáp án đúng = B (index 1)', q1[0] && q1[0].correct === 1, 'correct=' + JSON.stringify(q1[0] && q1[0].correct));
    check('câu 2: đáp án đúng = C (index 2)', q1[1] && q1[1].correct === 2, 'correct=' + JSON.stringify(q1[1] && q1[1].correct));
    check('câu 3: đáp án đúng = A (index 0)', q1[2] && q1[2].correct === 0, 'correct=' + JSON.stringify(q1[2] && q1[2].correct));
    check('câu có đáp án KHÔNG bị đánh dấu cần kiểm tra', q1[0] && q1[0].needsReview === false, JSON.stringify(q1[0] && q1[0].reviewReasons));

    // ------------------------------------------------------------------
    console.log('\n=== 4. Câu hỏi KHÔNG có đáp án trong ảnh -> correct = null + cần kiểm tra ===');
    check('câu 4 có correct = null (không tự đoán)', q1[3] && q1[3].correct === null, 'correct=' + JSON.stringify(q1[3] && q1[3].correct));
    check('câu 4 được đánh dấu needsReview', q1[3] && q1[3].needsReview === true, JSON.stringify(q1[3]));
    check('câu 4 có lý do cần kiểm tra', q1[3] && (q1[3].reviewReasons || []).join(' ').toLowerCase().indexOf('đáp án') >= 0,
        JSON.stringify(q1[3] && q1[3].reviewReasons));
    check('tổng số câu cần kiểm tra = 1', an1.json.needsReview === 1, 'needsReview=' + an1.json.needsReview);

    // ------------------------------------------------------------------
    console.log('\n=== 5. Ảnh chứa NHIỀU câu hỏi ===');
    const ex2 = await extract(cookie, [{ name: 'de-thi-8cau.png', type: 'image/png', buffer: fixture('de-thi-8cau.png') }]);
    check('extract ảnh 8 câu thành công', ex2.json && ex2.json.success === true, JSON.stringify(ex2.json).slice(0, 160));
    const an2 = await analyze(cookie, ex2.json.sessionId);
    check('tách đúng 8 câu hỏi', an2.json && an2.json.count === 8, 'count=' + (an2.json && an2.json.count));
    const q2 = (an2.json && an2.json.questions) || [];
    check('cả 8 câu đều có >= 2 đáp án', q2.length === 8 && q2.every(q => (q.options || []).length >= 2),
        JSON.stringify(q2.map(q => (q.options || []).length)));
    check('câu 7 nhận đúng đáp án C (index 2)', q2[6] && q2[6].correct === 2, 'correct=' + JSON.stringify(q2[6] && q2[6].correct));
    check('câu 8 (không có dấu *) -> correct = null', q2[7] && q2[7].correct === null, 'correct=' + JSON.stringify(q2[7] && q2[7].correct));

    // ------------------------------------------------------------------
    console.log('\n=== 6. Ảnh MỜ / OCR không đọc được -> báo lỗi rõ, KHÔNG tạo câu hỏi ===');
    const ex3 = await extract(cookie, [{ name: 'anh-mo.png', type: 'image/png', buffer: fixture('anh-mo.png') }]);
    check('vẫn upload được (ảnh hợp lệ)', ex3.json && ex3.json.success === true, JSON.stringify(ex3.json).slice(0, 160));
    const an3 = await analyze(cookie, ex3.json.sessionId);
    check('analyze thất bại (không có câu hỏi)', an3.json && an3.json.success === false, JSON.stringify(an3.json).slice(0, 200));
    check('đánh dấu lỗi do OCR (ocrIssues)', an3.json && an3.json.ocrIssues === true, JSON.stringify(an3.json).slice(0, 200));
    check('không nhận ra mốc câu hỏi nào', an3.json && an3.json.questionMarkers === 0, 'questionMarkers=' + (an3.json && an3.json.questionMarkers));
    check('có hướng dẫn cho giáo viên', an3.json && /mờ|rõ hơn/i.test(an3.json.error || ''), JSON.stringify(an3.json && an3.json.error));
    check('vẫn trả văn bản OCR để đối chiếu', typeof an3.json.text === 'string');

    // ------------------------------------------------------------------
    console.log('\n=== 7. File SAI ĐỊNH DẠNG / sai kiểu ===');
    const txt = await extract(cookie, [{ name: 'de-thi.txt', type: 'text/plain', buffer: Buffer.from('hello') }]);
    check('.txt bị từ chối (400)', txt.status === 400, 'status=' + txt.status);
    check('.txt có thông báo rõ ràng', txt.json && /không hỗ trợ/i.test(txt.json.error || ''), JSON.stringify(txt.json));

    const fakePng = await extract(cookie, [{ name: 'gia-danh.png', type: 'image/png', buffer: Buffer.from('không phải ảnh thật đâu') }]);
    check('ảnh giả (sai nội dung) bị từ chối', fakePng.json && fakePng.json.success === false, JSON.stringify(fakePng.json).slice(0, 200));
    check('báo rõ không đúng định dạng ảnh', fakePng.json && /định dạng/i.test(fakePng.json.error || ''), JSON.stringify(fakePng.json));

    const docxBuf = Buffer.from('PK\u0003\u0004 không phải docx thật');
    const docx = await extract(cookie, [{
        name: 'de-thi.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxBuf
    }]);
    check('Word gửi vào luồng OCR bị từ chối', docx.json && docx.json.success === false, JSON.stringify(docx.json).slice(0, 200));
    check('giải thích chỉ nhận ảnh', docx.json && /không phải ảnh/i.test(docx.json.error || ''), JSON.stringify(docx.json));

    console.log('\n=== 8. Ảnh VƯỢT DUNG LƯỢNG -> bị chặn ===');
    const bigImg = Buffer.concat([fixture('de-thi-4cau.png'), Buffer.alloc(9 * 1024 * 1024, 0x41)]); // > 8MB
    const tooBig = await extract(cookie, [{ name: 'anh-qua-lon.png', type: 'image/png', buffer: bigImg }]);
    check('ảnh > 8MB bị chặn', tooBig.json && tooBig.json.success === false, 'status=' + tooBig.status + ' ' + JSON.stringify(tooBig.json).slice(0, 160));
    check('thông báo quá dung lượng', tooBig.json && /quá lớn/i.test(tooBig.json.error || ''), JSON.stringify(tooBig.json));

    // ------------------------------------------------------------------
    console.log('\n=== 9. HỦY xem trước -> KHÔNG tạo bài / KHÔNG thêm câu hỏi ===');
    const afterPreviewOnly = await getExams(cookie);
    check('số bài kiểm tra không đổi sau khi chỉ xem trước',
        (afterPreviewOnly.exams || []).length === examsBeforeCount,
        'truoc=' + examsBeforeCount + ' sau=' + (afterPreviewOnly.exams || []).length);
    check('bài đang chọn không đổi', afterPreviewOnly.currentExamId === currentBefore);

    // ------------------------------------------------------------------
    console.log('\n=== 10. Giáo viên SỬA nội dung trước khi xác nhận ===');
    const editedFirst = 'Câu hỏi đã được giáo viên sửa lại?';
    const editedOptions = ['Đáp án một (sửa)', 'Đáp án hai (sửa)', 'Đáp án ba', 'Đáp án bốn'];
    const c1 = await confirm(cookie, {
        sessionId: an1.json.sessionId,
        destination: 'new',
        examName: 'TEST-OCR-EDITED',
        questions: q1.map((q, i) => i === 0
            ? toSavePayload(q, { question: editedFirst, options: editedOptions, correct: 2, points: 2 })
            : toSavePayload(q))
    });
    check('confirm thành công', c1.json && c1.json.success === true, JSON.stringify(c1.json).slice(0, 200));
    check('lưu 3 câu hợp lệ (bỏ câu thiếu đáp án)', c1.json && c1.json.saved === 3, 'saved=' + (c1.json && c1.json.saved));
    check('bỏ qua 1 câu chưa có đáp án', c1.json && c1.json.skipped && c1.json.skipped.length === 1, JSON.stringify(c1.json && c1.json.skipped));
    check('lý do bỏ qua nói rõ về đáp án',
        c1.json && c1.json.skipped && /đáp án/i.test(c1.json.skipped[0].reason || ''),
        JSON.stringify(c1.json && c1.json.skipped));
    if (c1.json && c1.json.examId) createdExams.push(c1.json.examId);

    // ------------------------------------------------------------------
    console.log('\n=== 11. Đã lưu -> MỞ LẠI được, nội dung là bản giáo viên sửa ===');
    const reopened = await getExam(cookie, c1.json.examId);
    check('đọc lại được bài vừa lưu', reopened.json && reopened.json.success === true, JSON.stringify(reopened.json).slice(0, 200));
    const savedQs = (reopened.json && reopened.json.exam && reopened.json.exam.questions) || [];
    check('bài lưu có 3 câu', savedQs.length === 3, 'len=' + savedQs.length);
    check('nội dung là bản ĐÃ SỬA, không phải bản OCR gốc',
        savedQs[0] && savedQs[0].question === editedFirst, JSON.stringify(savedQs[0] && savedQs[0].question));
    check('đáp án là bản đã sửa (C)', savedQs[0] && savedQs[0].correct === 2, JSON.stringify(savedQs[0] && savedQs[0].correct));
    check('điểm (points) được lưu đúng', savedQs[0] && Number(savedQs[0].points) === 2, JSON.stringify(savedQs[0] && savedQs[0].points));
    check('câu khác giữ điểm mặc định = 1', savedQs[1] && Number(savedQs[1].points) === 1, JSON.stringify(savedQs[1] && savedQs[1].points));
    check('đáp án đúng của câu 2 vẫn khớp OCR (C)', savedQs[1] && savedQs[1].correct === 2, JSON.stringify(savedQs[1] && savedQs[1].correct));

    const examList = await getExams(cookie);
    const savedExam = (examList.exams || []).find(e => e.id === c1.json.examId);
    check('bài mới xuất hiện trong danh sách với 3 câu', savedExam && savedExam.questionCount === 3, JSON.stringify(savedExam));
    check('bài đang chọn KHÔNG bị thay đổi', examList.currentExamId === currentBefore, 'current=' + examList.currentExamId);

    // ------------------------------------------------------------------
    console.log('\n=== 12. Không tự bịa: câu chưa có đáp án KHÔNG được lưu dù giáo viên cố lưu ===');
    const c2 = await confirm(cookie, {
        sessionId: an2.json.sessionId,
        destination: 'new',
        examName: 'TEST-OCR-NOANSWER',
        questions: [toSavePayload(q2[7])] // câu 8: correct = null
    });
    check('chỉ có câu thiếu đáp án -> không lưu câu nào', c2.json && c2.json.success === false, JSON.stringify(c2.json).slice(0, 200));
    check('nêu rõ lý do', c2.json && c2.json.skipped && c2.json.skipped.length === 1 && /đáp án/i.test(c2.json.skipped[0].reason || ''),
        JSON.stringify(c2.json && c2.json.skipped));

    // ------------------------------------------------------------------
    console.log('\n=== 13. Lưu cả đề 8 câu -> đọc lại đủ 8 câu ===');
    const c3 = await confirm(cookie, {
        sessionId: an2.json.sessionId,
        destination: 'new',
        examName: 'TEST-OCR-8CAU',
        questions: q2.map(q => toSavePayload(q, q.correct === null ? { correct: 0 } : {}))
    });
    check('lưu 8 câu', c3.json && c3.json.success === true && c3.json.saved === 8, JSON.stringify(c3.json).slice(0, 200));
    if (c3.json && c3.json.examId) createdExams.push(c3.json.examId);
    const re8 = await getExam(cookie, c3.json.examId);
    check('mở lại thấy đủ 8 câu', re8.json && re8.json.exam && re8.json.exam.questions.length === 8,
        'len=' + (re8.json && re8.json.exam && re8.json.exam.questions.length));

    // ------------------------------------------------------------------
    console.log('\n=== 14. Phiên đã dùng -> không lưu lại được (chống lặp) ===');
    const replay = await confirm(cookie, {
        sessionId: an2.json.sessionId,
        destination: 'new',
        examName: 'TEST-OCR-REPLAY',
        questions: [toSavePayload(q2[0])]
    });
    check('dùng lại phiên cũ bị từ chối', replay.json && replay.json.success === false, JSON.stringify(replay.json).slice(0, 160));

    // ------------------------------------------------------------------
    console.log('\n=== 15. Phiên không tồn tại / hết hạn ===');
    const badSession = await analyze(cookie, 'khong-ton-tai');
    check('analyze với sessionId sai -> success=false', badSession.json && badSession.json.success === false, JSON.stringify(badSession.json).slice(0, 160));
    check('thông báo hết hạn rõ ràng', badSession.json && /hết hạn|không tồn tại/i.test(badSession.json.error || ''), JSON.stringify(badSession.json));

    // ------------------------------------------------------------------
    console.log('\n=== 16. Bảo vệ: chưa đăng nhập không dùng được ===');
    const anonStatus = await fetch(BASE + '/api/ocr/status');
    check('status khi chưa đăng nhập -> 403', anonStatus.status === 403, 'status=' + anonStatus.status);

    const anonExtract = await extract(null, [{ name: 'de-thi-4cau.png', type: 'image/png', buffer: fixture('de-thi-4cau.png') }]);
    check('extract khi chưa đăng nhập -> 403', anonExtract.status === 403, 'status=' + anonExtract.status);

    const anonAnalyze = await analyze(null, an1.json.sessionId);
    check('analyze khi chưa đăng nhập -> 403', anonAnalyze.status === 403, 'status=' + anonAnalyze.status);

    // ------------------------------------------------------------------
    console.log('\n=== 17. Không lưu ảnh người dùng lên đĩa ===');
    const cacheDir = path.join(ROOT, 'data', 'ocr-cache');
    let cacheFiles = [];
    if (fs.existsSync(cacheDir)) {
        cacheFiles = fs.readdirSync(cacheDir).map(f => path.join(cacheDir, f));
    }
    const pngInCache = cacheFiles.filter(p => {
        try { return fs.statSync(p).isFile() && fs.readFileSync(p, { start: 0, end: 8 }).slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])); }
        catch (e) { return false; }
    });
    check('không có ảnh người dùng nào bị ghi vào data/ocr-cache', pngInCache.length === 0, JSON.stringify(pngInCache));

    // ------------------------------------------------------------------
    console.log('\n=== 18. Dọn dẹp: xóa các bài test đã tạo ===');
    let cleaned = 0;
    for (const id of createdExams) {
        const r = await fetch(BASE + '/api/exams/' + id, { method: 'DELETE', headers: { Cookie: cookie } });
        let j = null;
        try { j = await r.json(); } catch (e) { /* ignore */ }
        if (j && j.success === true) cleaned++;
    }
    check('đã xóa các bài test tạo ra', cleaned === createdExams.length, cleaned + '/' + createdExams.length);

    const finalList = await getExams(cookie);
    check('số bài trở về như ban đầu', (finalList.exams || []).length === examsBeforeCount,
        'truoc=' + examsBeforeCount + ' sau=' + (finalList.exams || []).length);
    check('bài đang chọn KHÔNG bị thay đổi bởi test',
        finalList.currentExamId === currentBefore, 'sau=' + finalList.currentExamId + ' truoc=' + currentBefore);

    console.log('\n----------------------------------------');
    console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})().catch(function (err) {
    console.error('\nLỗi không mong đợi: ' + (err && err.stack ? err.stack : err));
    process.exit(2);
});
