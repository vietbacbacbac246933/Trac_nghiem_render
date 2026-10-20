'use strict';
/**
 * lib/practice.js
 * Logic thuần cho chế độ Ôn tập: cấu hình, lượt làm, thời hạn và dữ liệu
 * trả về client (không bao giờ trả đáp án đúng khi giáo viên tắt).
 */

var crypto = require('crypto');

var REVIEW_MODES = { score: true, status: true, answer: true };

function isProvided(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

// null = không giới hạn. Chỉ nhận số nguyên dương.
function optionalPositiveInt(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!isFinite(n) || Math.floor(n) !== n || n < 1) return null;
    return n;
}

function normalizeConfig(settings) {
    settings = settings || {};
    var max = optionalPositiveInt(settings.practiceMaxAttempts);
    var minutes = optionalPositiveInt(settings.practiceTimeLimitMinutes);
    var mode = settings.practiceReviewMode;
    return {
        practiceMode: settings.practiceMode === true,
        maxAttempts: max,           // null = không giới hạn
        timeLimitMinutes: minutes,  // null = không giới hạn
        reviewMode: REVIEW_MODES[mode] ? mode : 'answer'
    };
}

// Kiểm tra dữ liệu giáo viên gửi lên. Trả về chuỗi lỗi hoặc null.
function validateConfig(input) {
    if (!input || typeof input !== 'object') return null;

    if (isProvided(input, 'practiceMaxAttempts') && input.practiceMaxAttempts !== null && input.practiceMaxAttempts !== '') {
        var n = Number(input.practiceMaxAttempts);
        if (!isFinite(n) || Math.floor(n) !== n || n < 1) {
            return 'Số lần làm bài phải là số nguyên lớn hơn 0 (hoặc chọn không giới hạn).';
        }
    }

    if (isProvided(input, 'practiceTimeLimitMinutes') && input.practiceTimeLimitMinutes !== null && input.practiceTimeLimitMinutes !== '') {
        var m = Number(input.practiceTimeLimitMinutes);
        if (!isFinite(m) || Math.floor(m) !== m || m < 1) {
            return 'Thời gian ôn tập phải là số phút nguyên lớn hơn 0 (hoặc chọn không giới hạn).';
        }
    }

    if (isProvided(input, 'practiceReviewMode') && input.practiceReviewMode !== null &&
        !REVIEW_MODES[input.practiceReviewMode]) {
        return 'Chế độ xem kết quả không hợp lệ.';
    }

    return null;
}

function newOwnerToken() {
    return crypto.randomBytes(16).toString('hex');
}

// Một lượt được tính ngay khi bắt đầu (kể cả đang làm dở) để không thể vượt giới hạn.
function newAttempt(opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var minutes = opts.timeLimitMinutes;
    var attempt = {
        id: 'att_' + now + '_' + crypto.randomBytes(4).toString('hex'),
        no: opts.no,
        status: 'in_progress',
        startedAt: new Date(now).toISOString(),
        deadline: minutes ? now + minutes * 60000 : null,
        submittedAt: null,
        timeSpentSeconds: null,
        reviewMode: opts.reviewMode || 'answer',
        answers: {},
        answersSavedAt: null,
        score: null,
        correctCount: null,
        partialCount: null,
        wrongCount: null,
        unansweredCount: null,
        totalQuestions: opts.totalQuestions || 0,
        details: []
    };
    return attempt;
}

function findInProgress(attempts) {
    var list = attempts || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i].status === 'in_progress') return list[i];
    }
    return null;
}

function findById(attempts, id) {
    var list = attempts || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return list[i];
    }
    return null;
}

function remainingAttempts(config, attempts) {
    if (!config || config.maxAttempts === null) return null;
    return Math.max(0, config.maxAttempts - (attempts || []).length);
}

function isExpired(attempt, nowMs) {
    return !!(attempt && attempt.deadline && (nowMs || Date.now()) > attempt.deadline);
}

function remainingSeconds(attempt, nowMs) {
    if (!attempt || !attempt.deadline) return null;
    return Math.max(0, Math.ceil((attempt.deadline - (nowMs || Date.now())) / 1000));
}

// Ghi kết quả chấm vào lượt làm (thay đổi tại chỗ, gọi 1 lần cho mỗi lượt).
function finalizeAttempt(attempt, grade, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var startedMs = new Date(attempt.startedAt).getTime();
    var endMs = now;
    if (attempt.deadline && endMs > attempt.deadline) endMs = attempt.deadline;

    attempt.status = opts.status || (isExpired(attempt, now) ? 'timeout' : 'submitted');
    attempt.submittedAt = new Date(now).toISOString();
    attempt.timeSpentSeconds = Math.max(0, Math.round((endMs - startedMs) / 1000));
    attempt.score = grade.score;
    attempt.correctCount = grade.correctCount;
    attempt.partialCount = grade.partialCount;
    attempt.wrongCount = grade.wrongCount;
    attempt.unansweredCount = grade.unansweredCount;
    attempt.totalQuestions = grade.totalQuestions;
    attempt.details = grade.details;
    return attempt;
}

function summary(attempt) {
    return {
        attemptId: attempt.id,
        attemptNo: attempt.no,
        status: attempt.status,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        deadline: attempt.deadline,
        timeSpentSeconds: attempt.timeSpentSeconds,
        score: attempt.score,
        correctCount: attempt.correctCount,
        partialCount: attempt.partialCount,
        wrongCount: attempt.wrongCount,
        unansweredCount: attempt.unansweredCount,
        totalQuestions: attempt.totalQuestions,
        reviewMode: attempt.reviewMode
    };
}

// Chỉ trả các trường được phép xem. 'score' không có chi tiết; 'status' không
// có đáp án đúng; 'answer' có đáp án đúng.
function publicReview(attempt, reviewMode) {
    var mode = REVIEW_MODES[reviewMode] ? reviewMode : 'score';
    if (mode === 'score') return null;

    var details = (attempt.details || []).map(function(d) {
        var out = {
            index: d.index,
            question: d.question,
            type: d.type,
            options: d.options || [],
            image: d.image || null,
            studentAnswer: d.studentAnswer,
            studentAnswerText: d.studentAnswerText,
            isCorrect: d.isCorrect,
            questionScore: d.questionScore,
            hasAnswer: d.hasAnswer,
            status: d.status
        };
        if (mode === 'answer') {
            out.correctAnswer = d.correctAnswer;
            out.correctAnswerText = d.correctAnswerText;
            out.correctList = d.correctList;
            out.correctTF = d.correctTF;
        }
        return out;
    });

    return {
        attemptId: attempt.id,
        attemptNo: attempt.no,
        status: attempt.status,
        reviewMode: mode,
        details: details
    };
}

module.exports = {
    REVIEW_MODES: REVIEW_MODES,
    normalizeConfig: normalizeConfig,
    validateConfig: validateConfig,
    newOwnerToken: newOwnerToken,
    newAttempt: newAttempt,
    findInProgress: findInProgress,
    findById: findById,
    remainingAttempts: remainingAttempts,
    isExpired: isExpired,
    remainingSeconds: remainingSeconds,
    finalizeAttempt: finalizeAttempt,
    summary: summary,
    publicReview: publicReview
};
