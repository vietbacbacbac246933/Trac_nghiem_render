'use strict';
/**
 * lib/review.js
 * Ham thuan cho danh sach on tap: chuan hoa cau hinh tung de va tinh
 * trang thai/lich su theo tung hoc sinh. Khong doc/ghi storage.
 */

function toInt(value, fallback) {
    var n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
}

function defaultSettings(exam) {
    var s = (exam && exam.settings) || {};
    return {
        maxAttempts: 0, // 0 = khong gioi han
        timeLimit: toInt(s.timeLimit, 0), // phut, 0 = khong gioi han
        showResult: true, // xem dung/sai sau khi nop
        showAnswers: false, // xem dap an dung sau khi nop
        practiceMode: false, // bao dung/sai ngay khi lam
        shuffleExam: s.shuffleExam !== false
    };
}

function normalizeSettings(raw, exam) {
    var d = defaultSettings(exam);
    raw = raw || {};
    return {
        maxAttempts: Math.max(0, toInt(raw.maxAttempts, d.maxAttempts)),
        timeLimit: Math.max(0, toInt(raw.timeLimit, d.timeLimit)),
        showResult: raw.showResult === undefined ? d.showResult : !!raw.showResult,
        showAnswers: raw.showAnswers === undefined ? d.showAnswers : !!raw.showAnswers,
        practiceMode: raw.practiceMode === undefined ? d.practiceMode : !!raw.practiceMode,
        shuffleExam: raw.shuffleExam === undefined ? d.shuffleExam : !!raw.shuffleExam
    };
}

function normalizeItem(raw, exam) {
    if (!raw || !raw.examId) return null;
    return {
        examId: String(raw.examId),
        settings: normalizeSettings(raw.settings, exam)
    };
}

// Kiem tra cau hinh giao vien gui len. 0 = khong gioi han.
function validateSettings(raw) {
    raw = raw || {};
    var limits = [
        ['maxAttempts', 'Số lần làm phải là số nguyên không âm (0 = không giới hạn).'],
        ['timeLimit', 'Thời gian làm bài phải là số phút nguyên không âm (0 = không giới hạn).']
    ];
    for (var i = 0; i < limits.length; i++) {
        var key = limits[i][0];
        var value = raw[key];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'boolean') return limits[i][1];
        var n = Number(value);
        if (!isFinite(n) || Math.floor(n) !== n || n < 0) return limits[i][1];
    }
    return null;
}

function countSubmitted(attempts, stt) {
    if (!Array.isArray(attempts)) return 0;
    return attempts.filter(function (a) {
        return a && a.status === 'submitted' && String(a.studentSTT) === String(stt);
    }).length;
}

// Lượt đã bắt đầu cũng tính vào giới hạn (kể cả đang làm dở) để không thể
// bỏ lượt dở rồi bắt đầu lượt mới để vượt giới hạn.
function countAttempts(attempts, stt) {
    if (!Array.isArray(attempts)) return 0;
    return attempts.filter(function (a) {
        return a && String(a.studentSTT) === String(stt);
    }).length;
}

function canAttempt(maxAttempts, usedCount) {
    var max = toInt(maxAttempts, 0);
    return max <= 0 || usedCount < max;
}

var CLOSE_GRACE_MS = 120000;

// Thoi gian cua luot da bat dau duoc chot luc start; giao vien sua cau hinh
// sau do khong lam thay doi dong ho cua luot dang lam.
function attemptTimeLimit(attempt, settings) {
    if (attempt && typeof attempt.timeLimit === 'number') return attempt.timeLimit;
    return (settings && settings.timeLimit) || 0;
}

// Lượt dở đã quá hạn (thời gian làm + 2 phút ân hạn) thì phải đóng, không
// được xóa để bắt đầu lượt mới.
function isOverDeadline(settings, attempt, nowMs) {
    if (!attempt || !settings) return false;
    var limit = attemptTimeLimit(attempt, settings);
    if (!(limit > 0)) return false;
    var started = new Date(attempt.startedAt).getTime();
    if (!isFinite(started)) return false;
    return (nowMs || Date.now()) - started > limit * 60000 + CLOSE_GRACE_MS;
}

// Quyết định cho /api/review/play: đóng lượt quá hạn, tiếp tục lượt dở,
// bắt đầu lượt mới hay từ chối vì hết lượt.
function planAttempt(attempts, settings, stt, nowMs) {
    var list = Array.isArray(attempts) ? attempts : [];
    var active = findActiveAttempt(list, stt);
    if (active && isOverDeadline(settings, active, nowMs)) {
        return { action: 'close', attempt: active };
    }
    if (active) return { action: 'resume', attempt: active };
    if (!canAttempt(settings.maxAttempts, countAttempts(list, stt))) {
        return { action: 'deny', attempt: null };
    }
    return { action: 'start', attempt: null };
}

function findActiveAttempt(attempts, stt) {
    if (!Array.isArray(attempts)) return null;
    for (var i = 0; i < attempts.length; i++) {
        var a = attempts[i];
        if (a && a.status === 'active' && String(a.studentSTT) === String(stt)) return a;
    }
    return null;
}

function summarize(attempts, stt) {
    var all = (Array.isArray(attempts) ? attempts : []).filter(function (a) {
        return a && String(a.studentSTT) === String(stt);
    });
    var list = all.filter(function (a) {
        return a.status === 'submitted';
    });
    list.sort(function (a, b) {
        return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
    });

    var best = null;
    var latest = null;
    for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!best || Number(a.score) > Number(best.score)) best = a;
        latest = a; // da sap xep cu -> moi
    }

    return {
        attemptCount: list.length,
        attemptsUsed: all.length,
        bestScore: best ? best.score : null,
        bestMaxScore: best ? best.maxScore : null,
        bestAttemptId: best ? best.id : null,
        latestScore: latest ? latest.score : null,
        latestMaxScore: latest ? latest.maxScore : null,
        latestAttemptId: latest ? latest.id : null,
        latestSubmittedAt: latest ? latest.submittedAt : null,
        lastTimeSpent: latest ? latest.timeSpent : null,
        hasActive: !!findActiveAttempt(attempts, stt)
    };
}

// ---------------------------------------------------------------------------
// Tong hop ket qua cho giao vien: gom luot da nop theo hoc sinh, giu lich su.
// ---------------------------------------------------------------------------
var STATUS_LABELS = {
    completed: 'Đã hoàn thành',
    active: 'Đang làm bài',
    none: 'Chưa làm'
};

function dateMs(value) {
    if (!value) return null;
    var ms = new Date(value).getTime();
    return isFinite(ms) ? ms : null;
}

// Thoi diem de sap xep luot: uu tien startedAt, sau do submittedAt.
function attemptTime(attempt) {
    var started = dateMs(attempt && attempt.startedAt);
    if (started !== null) return started;
    var submitted = dateMs(attempt && attempt.submittedAt);
    return submitted !== null ? submitted : 0;
}

// Cung thoi diem (du lieu cu) -> tie-break bang so luot roi den id de on dinh.
function compareAttempts(a, b) {
    var diff = attemptTime(a) - attemptTime(b);
    if (diff) return diff;
    var na = toInt(a && a.no, 0);
    var nb = toInt(b && b.no, 0);
    if (na !== nb) return na - nb;
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
}

function scoreOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
}

function parseDurationSeconds(value) {
    if (typeof value === 'number') {
        return isFinite(value) && value >= 0 ? Math.floor(value) : null;
    }
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (!text) return null;
    var h = /(\d+)\s*(?:giờ|tiếng)/i.exec(text);
    var m = /(\d+)\s*phút/i.exec(text);
    var s = /(\d+)\s*giây/i.exec(text);
    if (!h && !m && !s) return null;
    return (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
}

// timeSpent la nguon chinh; du lieu cu thieu thi tinh tu startedAt/submittedAt.
function attemptDurationSeconds(attempt) {
    if (!attempt) return null;
    var parsed = parseDurationSeconds(attempt.timeSpent);
    if (parsed !== null) return parsed;
    var started = dateMs(attempt.startedAt);
    var submitted = dateMs(attempt.submittedAt);
    if (started === null || submitted === null || submitted < started) return null;
    var seconds = Math.floor((submitted - started) / 1000);
    var limit = toInt(attempt.timeLimit, 0);
    if (limit > 0) seconds = Math.min(seconds, limit * 60);
    return seconds;
}

function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(seconds / 60) + ' phút ' + (seconds % 60) + ' giây';
}

// roster: [{ stt, name, className }] cua lop hien tai. Hoc sinh chi con trong
// lich su (khong con trong lop) van duoc dua vao tu attempts.
function buildExamResults(attempts, roster, fallbackClassName) {
    var entries = {};
    var order = [];

    function entryFor(stt) {
        var key = String(stt);
        if (!Object.prototype.hasOwnProperty.call(entries, key)) {
            entries[key] = {
                stt: stt,
                name: '',
                className: '',
                attempts: [],
                hasActive: false
            };
            order.push(key);
        }
        return entries[key];
    }

    (Array.isArray(roster) ? roster : []).forEach(function (s) {
        if (!s || s.stt === undefined || s.stt === null || s.stt === '') return;
        var e = entryFor(s.stt);
        if (!e.name && s.name) e.name = String(s.name).trim();
        if (!e.className && s.className) e.className = String(s.className).trim();
    });

    (Array.isArray(attempts) ? attempts : []).filter(Boolean).slice()
        .sort(compareAttempts)
        .forEach(function (a) {
            if (a.studentSTT === undefined || a.studentSTT === null || a.studentSTT === '') return;
            var e = entryFor(a.studentSTT);
            if (!e.name && a.studentName) e.name = String(a.studentName).trim();
            if (!e.className && a.studentClass) e.className = String(a.studentClass).trim();
            if (a.status === 'active') {
                e.hasActive = true;
                return;
            }
            if (a.status !== 'submitted') return;
            var duration = attemptDurationSeconds(a);
            e.attempts.push({
                id: a.id || null,
                score: scoreOrNull(a.score),
                maxScore: scoreOrNull(a.maxScore),
                durationSeconds: duration,
                durationText: duration === null ? null : formatDuration(duration),
                submittedAt: a.submittedAt || null,
                expired: !!a.expired
            });
        });

    var students = order.map(function (key) {
        var e = entries[key];
        var totalDuration = 0;
        var hasDuration = false;
        e.attempts.forEach(function (a, index) {
            a.attemptNo = index + 1;
            if (a.durationSeconds !== null) {
                totalDuration += a.durationSeconds;
                hasDuration = true;
            }
        });

        var latest = e.attempts.length ? e.attempts[e.attempts.length - 1] : null;
        var best = null;
        e.attempts.forEach(function (a) {
            if (a.score !== null && (!best || a.score > best.score)) best = a;
        });

        var status = e.attempts.length ? 'completed' : (e.hasActive ? 'active' : 'none');
        return {
            stt: e.stt,
            name: e.name || ('STT ' + e.stt),
            className: e.className || fallbackClassName || '',
            attempts: e.attempts,
            attemptCount: e.attempts.length,
            totalDurationSeconds: hasDuration ? totalDuration : null,
            totalDurationText: hasDuration ? formatDuration(totalDuration) : null,
            latestScore: latest ? latest.score : null,
            latestMaxScore: latest ? latest.maxScore : null,
            bestScore: best ? best.score : null,
            hasActive: e.hasActive,
            status: status,
            statusLabel: STATUS_LABELS[status]
        };
    });

    students.sort(function (a, b) {
        return String(a.stt).localeCompare(String(b.stt), 'vi', { numeric: true });
    });

    var latestScores = students.map(function (s) {
        return s.latestScore;
    }).filter(function (v) {
        return v !== null;
    });
    var sum = latestScores.reduce(function (acc, v) { return acc + v; }, 0);
    var maxScore = null;
    for (var i = 0; i < students.length; i++) {
        if (students[i].latestMaxScore !== null) {
            maxScore = students[i].latestMaxScore;
            break;
        }
    }

    return {
        students: students,
        summary: {
            totalStudents: students.length,
            submittedStudents: students.filter(function (s) { return s.attemptCount > 0; }).length,
            notSubmittedStudents: students.filter(function (s) { return s.attemptCount === 0; }).length,
            activeStudents: students.filter(function (s) { return s.hasActive && s.attemptCount === 0; }).length,
            averageScore: latestScores.length ? Math.round((sum / latestScores.length) * 100) / 100 : null,
            highestScore: latestScores.length ? Math.max.apply(null, latestScores) : null,
            lowestScore: latestScores.length ? Math.min.apply(null, latestScores) : null,
            maxScore: maxScore
        }
    };
}

// Bang ket qua dung chung cho giao dien va file Excel.
function resultTable(students) {
    var maxAttempts = 0;
    students.forEach(function (s) {
        if (s.attempts.length > maxAttempts) maxAttempts = s.attempts.length;
    });

    var headers = ['STT', 'Họ và tên', 'Lớp'];
    for (var i = 1; i <= maxAttempts; i++) headers.push('Lần ' + i);
    headers.push('Số lần làm', 'Thời gian làm bài', 'Trạng thái');

    var rows = students.map(function (s) {
        var row = [s.stt, s.name, s.className];
        for (var j = 0; j < maxAttempts; j++) {
            var a = s.attempts[j];
            row.push(a && a.score !== null ? a.score : '—');
        }
        row.push(s.attemptCount, s.totalDurationText || '—', s.statusLabel);
        return row;
    });

    return { headers: headers, rows: rows, maxAttempts: maxAttempts };
}

function statusOf(attempts, maxAttempts, stt) {
    var summary = summarize(attempts, stt);
    var retryable = canAttempt(maxAttempts, summary.attemptsUsed);
    return {
        attemptCount: summary.attemptCount,
        attemptsUsed: summary.attemptsUsed,
        bestScore: summary.bestScore,
        bestMaxScore: summary.bestMaxScore,
        latestScore: summary.latestScore,
        latestMaxScore: summary.latestMaxScore,
        latestSubmittedAt: summary.latestSubmittedAt,
        lastTimeSpent: summary.lastTimeSpent,
        hasActive: summary.hasActive,
        canAttempt: retryable,
        exhausted: !retryable,
        done: summary.attemptCount > 0,
        completed: summary.attemptCount > 0 && !retryable
    };
}

module.exports = {
    defaultSettings: defaultSettings,
    normalizeSettings: normalizeSettings,
    normalizeItem: normalizeItem,
    validateSettings: validateSettings,
    countSubmitted: countSubmitted,
    countAttempts: countAttempts,
    canAttempt: canAttempt,
    isOverDeadline: isOverDeadline,
    attemptTimeLimit: attemptTimeLimit,
    planAttempt: planAttempt,
    findActiveAttempt: findActiveAttempt,
    summarize: summarize,
    statusOf: statusOf,
    buildExamResults: buildExamResults,
    resultTable: resultTable,
    attemptDurationSeconds: attemptDurationSeconds
};
