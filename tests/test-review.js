// Kiem thu logic danh sach on tap (khong can khoi dong server).
var assert = require('assert');
var review = require('../lib/review');

// Cau hinh mac dinh: lay timeLimit/shuffleExam tu de goc, con lai theo chuan on tap.
var exam = { settings: { timeLimit: 45, shuffleExam: false } };
var d = review.defaultSettings(exam);
assert.strictEqual(d.maxAttempts, 0);
assert.strictEqual(d.timeLimit, 45);
assert.strictEqual(d.showResult, true);
assert.strictEqual(d.showAnswers, false);
assert.strictEqual(d.practiceMode, false);
assert.strictEqual(d.shuffleExam, false);

// Chuan hoa: so am/khong hop le ve 0, boolean dung kieu.
var s = review.normalizeSettings({
    maxAttempts: -2,
    timeLimit: 'abc',
    showResult: 0,
    showAnswers: 'yes',
    practiceMode: 1,
    shuffleExam: false
}, exam);
assert.strictEqual(s.maxAttempts, 0);
assert.strictEqual(s.timeLimit, 45); // 'abc' khong hop le => giu mac dinh cua de
assert.strictEqual(review.normalizeSettings({ timeLimit: 'abc' }, { settings: { timeLimit: 0 } }).timeLimit, 0);
assert.strictEqual(s.showResult, false);
assert.strictEqual(s.showAnswers, true);
assert.strictEqual(s.practiceMode, true);
assert.strictEqual(s.shuffleExam, false);

// Thieu truong => giu mac dinh cua de.
var s2 = review.normalizeSettings({}, { settings: { timeLimit: 30, shuffleExam: false } });
assert.strictEqual(s2.timeLimit, 30);
assert.strictEqual(s2.shuffleExam, false);
assert.strictEqual(s2.showResult, true);

// normalizeItem
assert.strictEqual(review.normalizeItem(null, exam), null);
assert.deepStrictEqual(review.normalizeItem({ examId: 'e1' }, exam), {
    examId: 'e1',
    settings: review.normalizeSettings({}, exam)
});

// validateSettings: chi nhan so nguyen khong am; 0 = khong gioi han.
assert.strictEqual(review.validateSettings({}), null);
assert.strictEqual(review.validateSettings({ maxAttempts: 0, timeLimit: 0 }), null);
assert.strictEqual(review.validateSettings({ maxAttempts: 3, timeLimit: 45 }), null);
assert.strictEqual(review.validateSettings({ maxAttempts: '3', timeLimit: '45' }), null);
assert.strictEqual(typeof review.validateSettings({ maxAttempts: -1 }), 'string');
assert.strictEqual(typeof review.validateSettings({ maxAttempts: true }), 'string');
assert.strictEqual(typeof review.validateSettings({ maxAttempts: 1.5 }), 'string');
assert.strictEqual(typeof review.validateSettings({ timeLimit: 'abc' }), 'string');
assert.strictEqual(typeof review.validateSettings({ timeLimit: -10 }), 'string');

// Gioi han luot
assert.strictEqual(review.canAttempt(0, 99), true);
assert.strictEqual(review.canAttempt(2, 1), true);
assert.strictEqual(review.canAttempt(2, 2), false);
assert.strictEqual(review.canAttempt(1, 0), true);

// Dem luot da nop cua dung hoc sinh, bo qua active va nguoi khac.
var attempts = [
    { id: 'a1', studentSTT: 1, status: 'submitted', score: 6, submittedAt: '2026-01-01T00:00:00Z', timeSpent: 100 },
    { id: 'a2', studentSTT: 1, status: 'active', score: 0, submittedAt: null, timeSpent: 0 },
    { id: 'a3', studentSTT: 1, status: 'submitted', score: 9, submittedAt: '2026-01-02T00:00:00Z', timeSpent: 200 },
    { id: 'a4', studentSTT: 1, status: 'submitted', score: 7, submittedAt: '2026-01-03T00:00:00Z', timeSpent: 150 },
    { id: 'a5', studentSTT: 2, status: 'submitted', score: 10, submittedAt: '2026-01-04T00:00:00Z', timeSpent: 50 }
];
assert.strictEqual(review.countSubmitted(attempts, 1), 3);
assert.strictEqual(review.countSubmitted(attempts, 2), 1);
assert.strictEqual(review.countSubmitted(attempts, 3), 0);

// Luot da bat dau (ke ca dang lam do) cung tinh vao gioi han.
assert.strictEqual(review.countAttempts(attempts, 1), 4);
assert.strictEqual(review.countAttempts(attempts, 2), 1);
assert.strictEqual(review.countAttempts(attempts, 3), 0);

var sum = review.summarize(attempts, 1);
assert.strictEqual(sum.attemptCount, 3);
assert.strictEqual(sum.bestScore, 9);
assert.strictEqual(sum.bestAttemptId, 'a3');
assert.strictEqual(sum.latestScore, 7);
assert.strictEqual(sum.latestAttemptId, 'a4');
assert.strictEqual(sum.latestSubmittedAt, '2026-01-03T00:00:00Z');
assert.strictEqual(sum.lastTimeSpent, 150);
assert.strictEqual(sum.hasActive, true);

// Khong co luot nao
var empty = review.summarize([], 1);
assert.strictEqual(empty.attemptCount, 0);
assert.strictEqual(empty.bestScore, null);
assert.strictEqual(empty.latestScore, null);

// Trang thai loc
var st = review.statusOf(attempts, 2, 1);
assert.strictEqual(st.done, true);
assert.strictEqual(st.exhausted, true);
assert.strictEqual(st.completed, true);
assert.strictEqual(st.canAttempt, false);

var st2 = review.statusOf(attempts, 0, 1);
assert.strictEqual(st2.done, true);
assert.strictEqual(st2.completed, false);
assert.strictEqual(st2.canAttempt, true);

var st3 = review.statusOf(attempts, 0, 3);
assert.strictEqual(st3.done, false);
assert.strictEqual(st3.canAttempt, true);

// Qua han = thoi gian lam + 2 phut an han.
var tfSettings = { timeLimit: 10 };
var startedAt = '2026-01-01T00:00:00.000Z';
var startMs = new Date(startedAt).getTime();
assert.strictEqual(review.isOverDeadline(tfSettings, { startedAt: startedAt }, startMs + 11 * 60000), false);
assert.strictEqual(review.isOverDeadline(tfSettings, { startedAt: startedAt }, startMs + 12 * 60000 + 1), true);
assert.strictEqual(review.isOverDeadline({ timeLimit: 0 }, { startedAt: startedAt }, startMs + 999 * 60000), false);
assert.strictEqual(review.isOverDeadline(tfSettings, null, startMs), false);

// Thoi gian chot luc bat dau: sua cau hinh sau do khong doi dong ho cua luot.
assert.strictEqual(review.attemptTimeLimit({ timeLimit: 5 }, { timeLimit: 60 }), 5);
assert.strictEqual(review.attemptTimeLimit({}, { timeLimit: 60 }), 60);
assert.strictEqual(review.attemptTimeLimit(null, null), 0);
assert.strictEqual(review.isOverDeadline({ timeLimit: 60 }, { startedAt: startedAt, timeLimit: 10 }, startMs + 13 * 60000), true);
assert.strictEqual(review.isOverDeadline({ timeLimit: 10 }, { startedAt: startedAt, timeLimit: 60 }, startMs + 13 * 60000), false);

// planAttempt: resume / close / deny / start
var planAttempts = [
    { id: 'p1', studentSTT: 7, status: 'active', startedAt: startedAt }
];
var planResume = review.planAttempt(planAttempts, tfSettings, 7, startMs + 60000);
assert.strictEqual(planResume.action, 'resume');
assert.strictEqual(planResume.attempt.id, 'p1');

var planClose = review.planAttempt(planAttempts, tfSettings, 7, startMs + 13 * 60000);
assert.strictEqual(planClose.action, 'close');
assert.strictEqual(planClose.attempt.id, 'p1');

// Het luot (da dung 1/1, khong co luot dở) => deny
var usedUp = [{ id: 's1', studentSTT: 7, status: 'submitted', score: 5 }];
assert.strictEqual(review.planAttempt(usedUp, { timeLimit: 0, maxAttempts: 1 }, 7, startMs).action, 'deny');
assert.strictEqual(review.planAttempt(usedUp, { timeLimit: 0, maxAttempts: 2 }, 7, startMs).action, 'start');
assert.strictEqual(review.planAttempt([], { timeLimit: 0, maxAttempts: 1 }, 7, startMs).action, 'start');

// --- Cham diem: trang thai cau tra loi (dung chung cho lich su) ---
var grading = require('../lib/grading');
var single = { type: 'single', question: 'q', options: ['A', 'B'], correct: 1, points: 1 };

var blank = grading.grade([single], {});
assert.strictEqual(blank.unansweredCount, 1);
assert.strictEqual(blank.wrongCount, 0);
assert.strictEqual(blank.details[0].status, 'unanswered');
assert.strictEqual(blank.details[0].hasAnswer, false);
assert.strictEqual(blank.score, 0);

var wrong = grading.grade([single], { 0: 0 });
assert.strictEqual(wrong.wrongCount, 1);
assert.strictEqual(wrong.unansweredCount, 0);
assert.strictEqual(wrong.details[0].status, 'wrong');

var right = grading.grade([single], { 0: 1 });
assert.strictEqual(right.correctCount, 1);
assert.strictEqual(right.details[0].status, 'correct');
assert.strictEqual(right.score, 10);

// truefalse dung mot phan; bo trong khong tinh la sai.
var tf = { type: 'truefalse', question: 'tf', options: ['a', 'b'], correctTF: [true, false], points: 1 };
var partialTf = grading.grade([tf], { 0: [true, true] });
assert.strictEqual(partialTf.partialCount, 1);
assert.strictEqual(partialTf.details[0].status, 'partial');
assert.strictEqual(partialTf.details[0].questionScore, 0.5);
var blankTf = grading.grade([tf], {});
assert.strictEqual(blankTf.unansweredCount, 1);
assert.strictEqual(blankTf.details[0].status, 'unanswered');

// snapshot: giu lai noi dung de xem lai sau khi de bi sua.
var snap = grading.grade([{ type: 'single', question: '<b>q</b>', options: ['A', 'B'], correct: 0, image: '/api/assets/x.png' }], { 0: 0 }, { snapshot: true });
assert.deepStrictEqual(snap.details[0].options, ['A', 'B']);
assert.strictEqual(snap.details[0].image, '/api/assets/x.png');

console.log('PASS: review tests');
