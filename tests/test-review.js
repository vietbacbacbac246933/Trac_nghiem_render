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
assert.strictEqual(right.score, 1);
assert.strictEqual(right.maxScore, 1);

// Tong diem la tong diem cac cau, co the lon hon 10.
var totalOverTen = grading.grade([
    { type: 'single', question: 'a', options: ['A', 'B'], correct: 0, points: 6 },
    { type: 'single', question: 'b', options: ['A', 'B'], correct: 0, points: 6 }
], { 0: 0, 1: 0 });
assert.strictEqual(totalOverTen.score, 12);
assert.strictEqual(totalOverTen.maxScore, 12);

// truefalse 4 y: 1/2/3/4 y dung -> 0,1 / 0,25 / 0,5 / 1.
var tf4 = { type: 'truefalse', question: 'tf4', options: ['a', 'b', 'c', 'd'], correctTF: [true, true, true, true], points: 1 };
var tf4Scores = [
    [true, false, false, false],
    [true, true, false, false],
    [true, true, true, false],
    [true, true, true, true]
];
assert.deepStrictEqual(tf4Scores.map(function (answer) {
    return grading.grade([tf4], { 0: answer }).score;
}), [0.1, 0.25, 0.5, 1]);

// truefalse khong du 4 y: chia deu nhu cu; bo trong khong tinh la sai.
var tf = { type: 'truefalse', question: 'tf', options: ['a', 'b'], correctTF: [true, false], points: 1 };
var partialTf = grading.grade([tf], { 0: [true, true] });
assert.strictEqual(partialTf.partialCount, 1);
assert.strictEqual(partialTf.details[0].status, 'partial');
assert.strictEqual(partialTf.details[0].questionScore, 0.5);
assert.strictEqual(partialTf.score, 0.5);
var blankTf = grading.grade([tf], {});
assert.strictEqual(blankTf.unansweredCount, 1);
assert.strictEqual(blankTf.details[0].status, 'unanswered');

// snapshot: giu lai noi dung de xem lai sau khi de bi sua.
var snap = grading.grade([{ type: 'single', question: '<b>q</b>', options: ['A', 'B'], correct: 0, image: '/api/assets/x.png' }], { 0: 0 }, { snapshot: true });
assert.deepStrictEqual(snap.details[0].options, ['A', 'B']);
assert.strictEqual(snap.details[0].image, '/api/assets/x.png');

// --- Tong hop ket qua cho giao vien ---
var roster = [
    { stt: '1', name: 'Nguyễn Văn A', className: '12A1' },
    { stt: '2', name: 'Trần Văn B', className: '12A1' },
    { stt: '3', name: 'Lê Văn C', className: '12A2' }
];
var teacherAttempts = [
    // Chen le thoi gian: phai duoc sap xep lai theo thoi diem bat dau.
    { id: 't3', studentSTT: '1', status: 'submitted', score: 0, maxScore: 10, startedAt: '2026-01-05T00:00:00Z', submittedAt: '2026-01-05T00:10:00Z', timeSpent: '10 phút 0 giây', fsExitCount: 0, tabSwitchCount: 2 },
    { id: 't1', studentSTT: '1', status: 'submitted', score: 6.5, maxScore: 10, startedAt: '2026-01-01T00:00:00Z', submittedAt: '2026-01-01T00:20:30Z', timeSpent: '20 phút 30 giây', fsExitCount: 6, tabSwitchCount: 8 },
    { id: 't2', studentSTT: '1', status: 'submitted', score: 8, maxScore: 10, startedAt: '2026-01-03T00:00:00Z', submittedAt: '2026-01-03T00:05:00Z', timeSpent: '', fsExitCount: 0, tabSwitchCount: 1 },
    { id: 't4', studentSTT: '1', status: 'active', startedAt: '2026-01-06T00:00:00Z' },
    { id: 't5', studentSTT: '2', status: 'submitted', score: '7', maxScore: '10', startedAt: '2026-01-02T00:00:00Z', submittedAt: '2026-01-02T00:30:00Z', timeSpent: 1800 },
    // Trung ten voi hoc sinh STT 1 nhung khac STT/lop -> phai la dong rieng.
    { id: 't6', studentSTT: '4', studentName: 'Nguyễn Văn A', studentClass: '12A3', status: 'submitted', score: 9, maxScore: 10, startedAt: '2026-01-04T00:00:00Z', submittedAt: '2026-01-04T00:09:00Z', timeSpent: '9 phút 0 giây' },
    // Dang lam do, chua nop.
    { id: 't7', studentSTT: '5', status: 'active', startedAt: '2026-01-07T00:00:00Z' },
    // Da nop nhung thieu diem -> khong tu gan 0.
    { id: 't8', studentSTT: '6', status: 'submitted', startedAt: '2026-01-08T00:00:00Z', submittedAt: '2026-01-08T00:01:00Z' },
    { id: 'bad', status: 'submitted', score: 10 }
];

var built = review.buildExamResults(teacherAttempts, roster, '12A1');
assert.strictEqual(built.students.length, 6);
var byStt = {};
built.students.forEach(function (s) { byStt[String(s.stt)] = s; });

assert.deepStrictEqual(byStt['1'].attempts.map(function (a) { return a.id; }), ['t1', 't2', 't3']);
assert.deepStrictEqual(byStt['1'].attempts.map(function (a) { return a.attemptNo; }), [1, 2, 3]);
assert.strictEqual(byStt['1'].latestScore, 0); // diem 0 hop le, khac voi chua lam
assert.strictEqual(byStt['1'].bestScore, 8);
assert.strictEqual(byStt['1'].attemptCount, 3);
assert.strictEqual(byStt['1'].hasActive, true);
assert.strictEqual(byStt['1'].status, 'completed');
assert.strictEqual(byStt['1'].totalDurationSeconds, 2130);
assert.strictEqual(byStt['1'].totalDurationText, '35 phút 30 giây');

assert.strictEqual(byStt['2'].latestScore, 7);
assert.strictEqual(byStt['2'].totalDurationText, '30 phút 0 giây');
assert.strictEqual(byStt['3'].attemptCount, 0);
assert.strictEqual(byStt['3'].status, 'none');
assert.strictEqual(byStt['3'].statusLabel, 'Chưa làm');
assert.strictEqual(byStt['4'].name, 'Nguyễn Văn A');
assert.strictEqual(byStt['4'].className, '12A3');
assert.strictEqual(byStt['5'].status, 'active');
assert.strictEqual(byStt['5'].statusLabel, 'Đang làm bài');
assert.strictEqual(byStt['6'].latestScore, null);

assert.deepStrictEqual(built.summary, {
    totalStudents: 6,
    submittedStudents: 4,
    notSubmittedStudents: 2,
    activeStudents: 1,
    averageScore: 5.33,
    highestScore: 9,
    lowestScore: 0,
    maxScore: 10
});

var table = review.resultTable(built.students);
assert.deepStrictEqual(table.headers, ['STT', 'Họ và tên', 'Lớp', 'Lần 1', 'Lần 2', 'Lần 3', 'Vi phạm (FS & tab)', 'Số lần làm', 'Thời gian làm bài', 'Trạng thái']);
assert.strictEqual(table.maxAttempts, 3);
var row1 = table.rows[built.students.findIndex(function (s) { return String(s.stt) === '1'; })];
assert.strictEqual(row1[6], 'L1: 6 & 8; L2: 0 & 1; L3: 0 & 2');
var row3 = table.rows[built.students.findIndex(function (s) { return String(s.stt) === '3'; })];
assert.deepStrictEqual(row3, ['3', 'Lê Văn C', '12A2', '—', '—', '—', '—', 0, '—', 'Chưa làm']);
var row2 = table.rows[built.students.findIndex(function (s) { return String(s.stt) === '2'; })];
assert.deepStrictEqual(row2, ['2', 'Trần Văn B', '12A1', 7, '—', '—', '—', 1, '30 phút 0 giây', 'Đã hoàn thành']);
var row6 = table.rows[built.students.findIndex(function (s) { return String(s.stt) === '6'; })];
assert.strictEqual(row6[3], '—'); // thieu diem -> khong tu dien 0

// File Excel: diem phai la so, tieu de giu nguyen, mo lai doc duoc.
var XLSX = require('xlsx');
var ws = XLSX.utils.aoa_to_sheet([table.headers].concat(table.rows));
var wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Ket qua');
var excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
var reread = XLSX.read(excelBuffer, { type: 'buffer' });
assert.strictEqual(reread.SheetNames[0], 'Ket qua');
var excelRows = XLSX.utils.sheet_to_json(reread.Sheets['Ket qua'], { header: 1, defval: '' });
assert.deepStrictEqual(excelRows[0], table.headers);
assert.strictEqual(excelRows[0].length, 10);
var excelRow1 = excelRows[1];
assert.strictEqual(excelRow1[0], table.rows[0][0]);
assert.strictEqual(typeof excelRow1[3], 'number'); // diem goc la so

// Thoi luong: uu tien timeSpent, thieu thi tinh tu startedAt/submittedAt, co chan theo timeLimit.
assert.strictEqual(review.attemptDurationSeconds({ timeSpent: '1 giờ 5 phút 3 giây' }), 3903);
assert.strictEqual(review.attemptDurationSeconds({ startedAt: '2026-01-01T00:00:00Z', submittedAt: '2026-01-01T00:10:00Z' }), 600);
assert.strictEqual(review.attemptDurationSeconds({ startedAt: '2026-01-01T00:00:00Z', submittedAt: '2026-01-01T00:10:00Z', timeLimit: 5 }), 300);
assert.strictEqual(review.attemptDurationSeconds({ startedAt: 'khong-hop-le', submittedAt: '2026-01-01T00:10:00Z' }), null);
assert.strictEqual(review.attemptDurationSeconds({ timeSpent: 'khong ro' }), null);

// Hai luot cung thoi diem bat dau -> thu tu on dinh theo so luot.
var tie = review.buildExamResults([
    { id: 'b', studentSTT: '1', status: 'submitted', score: 2, startedAt: '2026-02-01T00:00:00Z', no: 2 },
    { id: 'a', studentSTT: '1', status: 'submitted', score: 1, startedAt: '2026-02-01T00:00:00Z', no: 1 }
], [], '');
assert.deepStrictEqual(tie.students[0].attempts.map(function (a) { return a.id; }), ['a', 'b']);

// Nop lai: luot dang lam duoc chon; luot da nop cung id tra ve de tra ket qua cu;
// id la / cua hoc sinh khac thi khong dung.
var submitPool = [
    { id: 'x1', studentSTT: '10', status: 'submitted', score: 7 },
    { id: 'x2', studentSTT: '10', status: 'active' },
    { id: 'x3', studentSTT: '11', status: 'active' }
];
var hit = review.findSubmitTarget(submitPool, 'x2', '10');
assert.strictEqual(hit.attempt.id, 'x2');
assert.strictEqual(hit.submitted, null);
var again = review.findSubmitTarget(submitPool, 'x1', '10');
assert.strictEqual(again.attempt, null);
assert.strictEqual(again.submitted.id, 'x1');
assert.deepStrictEqual(review.findSubmitTarget(submitPool, 'x3', '10'), { attempt: null, submitted: null });
assert.deepStrictEqual(review.findSubmitTarget(submitPool, 'khong-co', '10'), { attempt: null, submitted: null });
assert.deepStrictEqual(review.findSubmitTarget(submitPool, null, '10'), { attempt: null, submitted: null });

console.log('PASS: review tests');
