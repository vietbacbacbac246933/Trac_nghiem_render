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
    statusOf: statusOf
};
