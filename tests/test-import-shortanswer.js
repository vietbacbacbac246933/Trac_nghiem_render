'use strict';
/**
 * Test import Word: nhận diện Phần trả lời ngắn, tách câu, lưu và chấm điểm.
 *
 * Yêu cầu server đang chạy với TEACHER_PASSWORD=test123:
 *   $env:PORT='3999'; $env:TEACHER_PASSWORD='test123'; node server.js
 *   node tests/test-import-shortanswer.js
 *
 * Đổi địa chỉ bằng TEST_BASE (mặc định http://127.0.0.1:3999).
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { Document, Packer, Paragraph, TextRun } = require(path.join(ROOT, 'node_modules', 'docx'));

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3999';
const PASSWORD = process.env.TEST_PASSWORD || 'test123';

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('  PASS  ' + name); }
    else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const DNA_TEXT = 'Có 8 phân tử DNA tự nhân đôi một số lần bằng nhau đã tổng hợp được 112 mạch pôlinucleotide mới lấy nguyên liệu hoàn toàn từ môi trường nội bào. Số lần tự nhân đôi của mỗi phân tử DNA trên là bao nhiêu?';

async function buildDocx() {
    const doc = new Document({
        sections: [{
            children: [
                new Paragraph('PHẦN I. TRẮC NGHIỆM NHIỀU PHƯƠNG ÁN'),
                new Paragraph('Câu 1. Thủ đô của Việt Nam là thành phố nào?'),
                new Paragraph('A. TP. Hồ Chí Minh'),
                new Paragraph('B. Hà Nội *'),
                new Paragraph('C. Đà Nẵng'),
                new Paragraph('D. Cần Thơ'),
                new Paragraph('Câu 2. Kết quả của 2 + 2 bằng bao nhiêu?'),
                new Paragraph('A. 3'),
                new Paragraph('B. 4 *'),
                new Paragraph('C. 5'),
                new Paragraph('D. 6'),

                new Paragraph('PHẦN II. CÂU TRẮC NGHIỆM ĐÚNG SAI'),
                new Paragraph('Câu 1. Xét các phát biểu sau về nước:'),
                new Paragraph('a) Nước có công thức hóa học là H2O. (Đ)'),
                new Paragraph('b) Nước không dẫn điện. (S)'),

                new Paragraph('PHẦN 3. TRẮC NGHIỆM TRẢ LỜI NGẮN'),
                new Paragraph('Câu 1. Tính 2 + 3.'),
                new Paragraph('Đáp án: 5'),
                new Paragraph('Câu 2. ' + DNA_TEXT),
                new Paragraph('Đáp án đúng: 3'),
                new Paragraph('Câu 3. Viết kết quả của 5/2 dưới dạng số thập phân.'),
                new Paragraph('Hết')
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

async function preview(cookie, buffer) {
    const fd = new FormData();
    fd.append('files', new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }), 'de-tra-loi-ngan.docx');
    const res = await fetch(BASE + '/api/import/preview', {
        method: 'POST', headers: { Cookie: cookie }, body: fd
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

async function confirm(cookie, body) {
    const res = await fetch(BASE + '/api/import/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body)
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

async function submit(answers, stt) {
    const res = await fetch(BASE + '/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            studentSTT: String(stt || 1),
            studentName: 'Test Short Answer',
            studentClass: 'Test',
            answers: answers,
            timeSpent: '1 phút'
        })
    });
    return await res.json();
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

    console.log('\n=== 1. Preview: nhận diện đúng Phần 3 ===');
    const docx = await buildDocx();
    const p = await preview(cookie, docx);
    check('preview thành công', p.json && p.json.success === true, JSON.stringify(p.json).slice(0, 300));
    const qs = (p.json && p.json.questions) || [];
    check('có 6 câu (2 một đáp án, 1 đúng/sai, 3 trả lời ngắn)', qs.length === 6, 'count=' + qs.length);
    check('câu 1 vẫn là một đáp án', qs[0] && qs[0].type === 'single', qs[0] && qs[0].type);
    check('câu 2 vẫn là một đáp án', qs[1] && qs[1].type === 'single', qs[1] && qs[1].type);
    check('câu 3 là đúng/sai', qs[2] && qs[2].type === 'truefalse', qs[2] && qs[2].type);
    check('câu 4 là trả lời ngắn', qs[3] && qs[3].type === 'shortanswer', qs[3] && qs[3].type);
    check('câu 5 là trả lời ngắn', qs[4] && qs[4].type === 'shortanswer', qs[4] && qs[4].type);
    check('câu 6 là trả lời ngắn', qs[5] && qs[5].type === 'shortanswer', qs[5] && qs[5].type);

    console.log('\n=== 2. Nội dung câu trả lời ngắn ===');
    check('câu trả lời ngắn đầu không có phương án A-D', qs[3] && qs[3].options.length === 0, JSON.stringify(qs[3] && qs[3].options));
    check('câu DNA giữ đủ nội dung', qs[4] && qs[4].question.indexOf('112 mạch pôlinucleotide') >= 0, qs[4] && qs[4].question);
    check('câu DNA không lẫn tiêu đề phần', qs[4] && !/PHẦN|TRẮC NGHIỆM TRẢ LỜI NGẮN/i.test(qs[4].question), qs[4] && qs[4].question);
    check('đáp án câu DNA trích được = 3', qs[4] && qs[4].correctAnswer === '3', qs[4] && qs[4].correctAnswer);
    check('câu 5/2 giữ nội dung phân số', qs[5] && /5\/2/.test(qs[5].question), qs[5] && qs[5].question);
    check('câu 5/2 không bị gộp vào câu DNA', qs[5] && /112 mạch/.test(qs[5].question) === false, qs[5] && qs[5].question);
    check('câu 5/2 chưa có đáp án -> cần kiểm tra', qs[5] && qs[5].correctAnswer === null && qs[5].needsReview === true, JSON.stringify(qs[5]));
    check('lý do nêu rõ thiếu đáp án', qs[5] && (qs[5].reviewReasons || []).join(' ').indexOf('đáp án') >= 0, JSON.stringify(qs[5] && qs[5].reviewReasons));
    check('"Hết" không lẫn vào câu cuối', qs[5] && !/Hết/i.test(qs[5].question), qs[5] && qs[5].question);

    console.log('\n=== 3. Lưu: câu chưa có đáp án bị bỏ qua, không tự bịa ===');
    const c = await confirm(cookie, {
        sessionId: p.json.sessionId,
        destination: 'current',
        questions: qs.map(q => ({
            include: true, type: q.type, question: q.question, options: q.options,
            correct: q.correct, correctList: q.correctList, correctTF: q.correctTF,
            correctAnswer: q.correctAnswer
        }))
    });
    check('confirm thành công', c.json && c.json.success === true, JSON.stringify(c.json).slice(0, 300));
    check('lưu 5 câu hợp lệ', c.json && c.json.saved === 5, 'saved=' + (c.json && c.json.saved));
    check('bỏ qua 1 câu thiếu đáp án trả lời ngắn', c.json && c.json.skipped.length === 1, JSON.stringify(c.json && c.json.skipped));
    check('lý do bỏ qua là thiếu đáp án trả lời ngắn',
        c.json && /trả lời ngắn/i.test(c.json.skipped[0].reason), JSON.stringify(c.json && c.json.skipped));

    console.log('\n=== 4. Dữ liệu đã lưu giữ đúng loại và đáp án ===');
    const savedRes = await fetch(BASE + '/api/questions', { headers: { Cookie: cookie } });
    const saved = await savedRes.json();
    check('lưu đúng 5 câu', Array.isArray(saved) && saved.length === 5, 'len=' + (Array.isArray(saved) ? saved.length : '?'));
    const shortSaved = (saved || []).filter(q => q.type === 'shortanswer');
    check('có 2 câu trả lời ngắn đã lưu', shortSaved.length === 2, 'len=' + shortSaved.length);
    check('đáp án "5" được lưu', shortSaved[0] && shortSaved[0].correctAnswer === '5', JSON.stringify(shortSaved[0] && shortSaved[0].correctAnswer));
    check('đáp án "3" của câu DNA được lưu', shortSaved[1] && shortSaved[1].correctAnswer === '3', JSON.stringify(shortSaved[1] && shortSaved[1].correctAnswer));
    check('câu trả lời ngắn không có options', shortSaved[0] && shortSaved[0].options.length === 0, JSON.stringify(shortSaved[0] && shortSaved[0].options));

    console.log('\n=== 5. Học sinh làm bài + chấm điểm ===');
    await fetch(BASE + '/api/exam/open', { method: 'POST', headers: { Cookie: cookie } });
    const exam = await (await fetch(BASE + '/api/exam')).json();
    check('đề trả về 5 câu', exam.questions && exam.questions.length === 5, exam.questions && exam.questions.length);
    check('đề có câu trả lời ngắn', (exam.questions || []).filter(q => q.type === 'shortanswer').length === 2);
    check('đề không lộ đáp án trả lời ngắn', JSON.stringify(exam).indexOf('"correctAnswer"') === -1, 'payload leaks correctAnswer');

    const answers = exam.questions.map((q) => {
        if (q.type === 'single') return 1;
        if (q.type === 'truefalse') return [true, false];
        if (/112 mạch/.test(q.question || '')) return '3';
        return '5';
    });
    const r1 = await submit(answers, 901);
    check('nộp bài thành công', r1 && r1.success === true, JSON.stringify(r1).slice(0, 300));
    check('cả 5 câu (gồm 2 trả lời ngắn) được chấm đúng', r1 && r1.correctCount === 5, 'correct=' + (r1 && r1.correctCount));
    check('không có câu bị coi là sai', r1.wrongCount === 0, 'wrong=' + (r1 && r1.wrongCount));

    const answers2 = exam.questions.map((q) => {
        if (q.type === 'single') return 1;
        if (q.type === 'truefalse') return [true, false];
        if (/112 mạch/.test(q.question || '')) return '3,0';
        return '5.00';
    });
    const r2 = await submit(answers2, 902);
    check('chấp nhận 3,0 và 5.00 (dấu phẩy/chấm, số 0 cuối)', r2 && r2.correctCount === r1.correctCount, JSON.stringify({ r1: r1.correctCount, r2: r2.correctCount }));

    const answers3 = exam.questions.map((q) => {
        if (q.type === 'single') return 1;
        if (q.type === 'truefalse') return [true, false];
        if (/112 mạch/.test(q.question || '')) return 'abc';
        return '';
    });
    const r3 = await submit(answers3, 903);
    check('đáp án sai định dạng/bỏ trống không được chấm đúng', r3 && r3.correctCount === r1.correctCount - 2, JSON.stringify(r3));

    console.log('\n----------------------------------------');
    console.log('Kết quả: ' + passed + ' PASS, ' + failed + ' FAIL');
    process.exit(failed ? 1 : 0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});