'use strict';
/**
 * Test cho lib/offline-quiz.js (khong can khoi dong server).
 *   node tests/test-offline-quiz.js
 */

const assert = require('assert');
const path = require('path');
const offline = require(path.join(__dirname, '..', 'lib', 'offline-quiz'));

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('  PASS  ' + name); }
    catch (err) { failed++; console.log('  FAIL  ' + name + '  -> ' + err.message); }
}

console.log('normalizeSettings');
check('on tap: giu so luot, bo thoi gian', () => {
    assert.deepStrictEqual(offline.normalizeSettings({ mode: 'practice', attempts: 5, minutes: 90, showAnswers: false }),
        { mode: 'practice', attempts: 5, minutes: 0, showAnswers: false, shuffle: true });
});
check('thi: chi 1 luot, giu thoi gian', () => {
    assert.deepStrictEqual(offline.normalizeSettings({ mode: 'exam', attempts: 5, minutes: 90 }),
        { mode: 'exam', attempts: 1, minutes: 90, showAnswers: true, shuffle: true });
});
check('tat tron cau hoi', () => {
    assert.strictEqual(offline.normalizeSettings({ mode: 'practice', shuffle: false }).shuffle, false);
});
check('gia tri rac duoc kep trong khoang', () => {
    assert.strictEqual(offline.normalizeSettings({ mode: 'exam', minutes: 'abc' }).minutes, 0);
    assert.strictEqual(offline.normalizeSettings({ mode: 'practice', attempts: 999 }).attempts, 99);
    assert.strictEqual(offline.normalizeSettings({ mode: 'practice', attempts: -3 }).attempts, 0);
});

console.log('buildOrder');
check('khong tron -> giu nguyen thu tu', () => {
    assert.deepStrictEqual(offline.buildOrder(4, false), [0, 1, 2, 3]);
});
check('tron -> du va khac thu tu goc', () => {
    const order = offline.buildOrder(20, true, () => 0.01);
    assert.deepStrictEqual(order.slice().sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
    assert.notDeepStrictEqual(order, Array.from({ length: 20 }, (_, i) => i));
});
check('tron voi rng co dinh -> ket qua lap lai duoc', () => {
    let seed = 0;
    const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const a = offline.buildOrder(10, true, rng);
    seed = 0;
    const b = offline.buildOrder(10, true, rng);
    assert.deepStrictEqual(a, b);
});

console.log('renderMathInHtml');
check('cong thuc noi dong -> MathML', () => {
    const html = offline.renderMathInHtml('Tính \\(x^2 + 1\\)');
    assert.ok(html.includes('<math'), 'khong co <math>');
    assert.ok(!html.includes('\\('), 'con delimiter LaTeX');
});
check('cong thuc doc lap + entity &lt;', () => {
    const html = offline.renderMathInHtml('\\[x &lt; 2\\]');
    assert.ok(html.includes('<math'), 'khong co <math>');
    assert.ok(html.includes('display="block"'), 'khong phai display math');
});
check('van ban thuong giu nguyen', () => {
    assert.strictEqual(offline.renderMathInHtml('Không có công thức'), 'Không có công thức');
});

console.log('renderQuiz');
const questions = [
    { type: 'single', question: 'Thủ đô Việt Nam?', options: ['Hà Nội', 'Huế'], correct: 0, points: 2 },
    { type: 'multi', question: 'Chọn số chẵn', options: ['1', '2', '4'], correct: 1, correctList: [1, 2], points: 1 },
    { type: 'truefalse', question: 'Đúng hay sai', options: ['A', 'B'], correctTF: [true, false], points: 1 },
    { type: 'shortanswer', question: '2 + 2 = ?', options: [], correctAnswer: '4', points: 1 }
];

const html = offline.renderQuiz({
    title: 'Đề lịch sử',
    questions: questions,
    settings: { mode: 'practice', attempts: 3, showAnswers: true }
});

check('la mot file HTML day du', () => {
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<html lang="vi">'));
    assert.ok(html.includes('Đề lịch sử'));
    assert.ok(html.includes('id="quiz-data"'));
    assert.ok(html.includes('offlineQuiz:'));
});
check('chi co 2 the script (du lieu + ung dung)', () => {
    assert.strictEqual((html.match(/<\/script>/g) || []).length, 2);
});
check('noi dung dap an duoc nhung', () => {
    assert.ok(html.includes('Thủ đô Việt Nam?'));
    assert.ok(html.includes('"correct":0'));
});
check('noi dung chua </script> khong pha duoc file', () => {
    const evilQuestions = JSON.parse(JSON.stringify(questions));
    evilQuestions[0].question = 'Xem: </script><script>alert(1)</script>';
    const evil = offline.renderQuiz({
        title: '</script><script>alert(1)</script>',
        questions: evilQuestions,
        settings: { mode: 'exam' }
    });
    assert.strictEqual((evil.match(/<\/script>/g) || []).length, 2);
    assert.ok(!evil.includes('</script><script>alert(1)</script>'));
    assert.ok(evil.includes('\\u003c/script>'), 'JSON chua duoc escape "<"');
});
check('cung noi dung -> cung id (on dinh)', () => {
    const a = offline.renderQuiz({ title: 'X', questions: questions, settings: { mode: 'exam' } });
    const b = offline.renderQuiz({ title: 'X', questions: questions, settings: { mode: 'exam' } });
    const id = s => (s.match(/"id":"([a-f0-9]{12})"/) || [])[1];
    assert.ok(id(a));
    assert.strictEqual(id(a), id(b));
});
check('doi dap an -> doi id (khong dung lai luot cu)', () => {
    const changed = JSON.parse(JSON.stringify(questions));
    changed[0].correct = 1;
    const a = offline.renderQuiz({ title: 'X', questions: questions, settings: { mode: 'practice' } });
    const b = offline.renderQuiz({ title: 'X', questions: changed, settings: { mode: 'practice' } });
    const id = s => (s.match(/"id":"([a-f0-9]{12})"/) || [])[1];
    assert.notStrictEqual(id(a), id(b));
});
check('khong co cau hoi van render duoc', () => {
    const empty = offline.renderQuiz({ title: 'Trống', questions: [], settings: {} });
    assert.ok(empty.includes('"questions":[]'));
});
check('lich su lam bai thu gon tung luot', () => {
    assert.ok(html.includes('Lịch sử làm bài'));
    assert.ok(html.includes('<details class="run"'), 'moi luot phai la <details> thu gon');
});
check('moi luot xem lai duoc bai lam + bo loc', () => {
    assert.ok(html.includes('data-rev-filter'), 'thieu bo loc trong bai lam');
    assert.ok(html.includes('Xem lại bài làm'), 'thieu phan xem lai');
    assert.ok(html.includes('data-rev="'), 'thieu cho gan bai lam cua tung luot');
});
check('lich su luu so cau dung/sai va dap an tung luot', () => {
    assert.ok(html.includes('correct: res.correct'));
    assert.ok(html.includes('wrong: res.wrong'));
    assert.ok(/runs\.push\(\{[\s\S]*?answers: answers/.test(html), 'moi luot phai luu dap an de xem lai');
});
check('tron cau hoi theo tung luot', () => {
    assert.ok(html.includes('function buildOrder'), 'thieu ham tron');
    assert.ok(html.includes('buildOrder(QS.length, CFG.shuffle)'), 'chua tao thu tu khi bat dau luot');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
