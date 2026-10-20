'use strict';
/**
 * lib/grading.js
 * Chấm điểm dùng chung cho chế độ Thi (/api/submit) và Ôn tập (/api/practice/submit).
 * Mọi câu trả lời đều được chấm ở server; client không tự quyết định điểm.
 */

var shortAnswer = require('./short-answer');

// Diem cua 1 cau (mac dinh 1). Khong co `points` thi cau do 1 diem.
function normalizePoints(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 1;
    if (n > 100) return 100;
    return Math.round(n * 100) / 100;
}

// Điểm từng phát biểu của câu Đúng/Sai 4 ý theo quy tắc đang dùng.
// Câu Đúng/Sai không đủ 4 ý thì chia đều để không tự bịa thang điểm khác.
var TRUE_FALSE_SCORES_4 = [0, 0.1, 0.25, 0.5, 1];

// Trả về số thực 0.0–1.0 (phần điểm của câu đó)
// single/multi: 0 hoặc 1 (all-or-nothing)
// truefalse: 1/2/3/4 phát biểu đúng -> 0,1 / 0,25 / 0,5 / 1 (câu 4 ý)
function scoreQuestion(q, studentAnswer) {
    var type = q.type || 'single';

    if (type === 'single') {
        return studentAnswer === q.correct ? 1 : 0;
    }

    if (type === 'multi') {
        if (!Array.isArray(studentAnswer) || !Array.isArray(q.correctList)) return 0;
        if (studentAnswer.length !== q.correctList.length) return 0;
        var sorted1 = studentAnswer.slice().sort(function(a, b) { return a - b; });
        var sorted2 = q.correctList.slice().sort(function(a, b) { return a - b; });
        for (var i = 0; i < sorted1.length; i++) {
            if (sorted1[i] !== sorted2[i]) return 0;
        }
        return 1;
    }

    if (type === 'truefalse') {
        if (!Array.isArray(studentAnswer) || !Array.isArray(q.correctTF)) return 0;
        var total = q.correctTF.length;
        if (total === 0) return 0;
        var correct = 0;
        for (var j = 0; j < total; j++) {
            if (j < studentAnswer.length && studentAnswer[j] === q.correctTF[j]) correct++;
        }
        if (total === 4) return TRUE_FALSE_SCORES_4[correct];
        return correct / total;
    }

    if (type === 'shortanswer') {
        // So khop chinh xac ve gia tri so; sai dinh dang/bo trong -> 0.
        return shortAnswer.equals(studentAnswer, q.correctAnswer) ? 1 : 0;
    }

    return 0;
}

function hasAnswerValue(studentAnswer) {
    return studentAnswer !== undefined && studentAnswer !== null && studentAnswer !== -1
        && !(Array.isArray(studentAnswer) && studentAnswer.length === 0)
        && !(typeof studentAnswer === 'string' && studentAnswer.trim() === '');
}

function buildDetail(q, index, studentAnswer, opts) {
    opts = opts || {};
    var type = q.type || 'single';
    var questionScore = scoreQuestion(q, studentAnswer); // 0.0–1.0
    var isCorrect = questionScore === 1;
    var hasAnswer = hasAnswerValue(studentAnswer);

    var studentAnswerText = null;
    var correctAnswerText = null;
    if (type === 'single') {
        studentAnswerText = (typeof studentAnswer === 'number' && studentAnswer >= 0 && studentAnswer < q.options.length)
            ? q.options[studentAnswer] : null;
        correctAnswerText = q.options[q.correct];
    } else if (type === 'multi') {
        studentAnswerText = Array.isArray(studentAnswer)
            ? studentAnswer.map(function(i) { return q.options[i] || ''; }).join(', ') : null;
        correctAnswerText = Array.isArray(q.correctList)
            ? q.correctList.map(function(i) { return q.options[i] || ''; }).join(', ') : '';
    } else if (type === 'truefalse') {
        studentAnswerText = Array.isArray(studentAnswer)
            ? studentAnswer.map(function(v, i) { return String.fromCharCode(65 + i) + ': ' + (v === true ? 'Đúng' : v === false ? 'Sai' : '?'); }).join(', ') : null;
        correctAnswerText = Array.isArray(q.correctTF)
            ? q.correctTF.map(function(v, i) { return String.fromCharCode(65 + i) + ': ' + (v ? 'Đúng' : 'Sai'); }).join(', ') : '';
    } else if (type === 'shortanswer') {
        studentAnswerText = (typeof studentAnswer === 'string' || typeof studentAnswer === 'number')
            ? String(studentAnswer).trim() || null : null;
        correctAnswerText = q.correctAnswer || '';
    }

    var status = isCorrect ? 'correct' : (!hasAnswer ? 'unanswered' : (questionScore > 0 ? 'partial' : 'wrong'));

    var detail = {
        index: index,
        question: q.question,
        type: type,
        studentAnswer: studentAnswer,
        studentAnswerText: studentAnswerText,
        correctAnswer: type === 'shortanswer' ? (q.correctAnswer || null) : q.correct,
        correctAnswerText: correctAnswerText,
        correctList: q.correctList || null,
        correctTF: q.correctTF || null,
        isCorrect: isCorrect,
        questionScore: questionScore,
        hasAnswer: hasAnswer,
        status: status
    };

    // Snapshot nội dung để xem lại sau khi giáo viên sửa đề.
    if (opts.snapshot) {
        detail.options = Array.isArray(q.options) ? q.options.slice() : [];
        detail.image = q.image || null;
    }
    return detail;
}

function grade(questions, answers, opts) {
    var list = Array.isArray(questions) ? questions : [];
    var given = answers || {};
    var totalScore = 0;
    var totalPoints = 0;
    var correctCount = 0;
    var partialCount = 0;
    var wrongCount = 0;
    var unansweredCount = 0;

    var details = list.map(function(q, index) {
        var studentAnswer = given[index];
        var detail = buildDetail(q, index, studentAnswer, opts);
        var qPoints = normalizePoints(q.points);
        totalScore += detail.questionScore * qPoints;
        totalPoints += qPoints;
        if (detail.isCorrect) correctCount++;
        else if (!detail.hasAnswer) unansweredCount++;
        else if (detail.questionScore > 0) partialCount++;
        else wrongCount++;
        return detail;
    });

    // Điểm bài = tổng điểm các câu đã đạt, không quy về thang 10.
    // Làm tròn 2 chữ số để giữ được mức 0,1 / 0,25.
    var score = Math.round(totalScore * 100) / 100;
    var maxScore = Math.round(totalPoints * 100) / 100;

    return {
        score: score,
        maxScore: maxScore,
        correctCount: correctCount,
        partialCount: partialCount,
        wrongCount: wrongCount,
        unansweredCount: unansweredCount,
        totalQuestions: list.length,
        details: details
    };
}

module.exports = {
    normalizePoints: normalizePoints,
    scoreQuestion: scoreQuestion,
    hasAnswer: hasAnswerValue,
    grade: grade
};
