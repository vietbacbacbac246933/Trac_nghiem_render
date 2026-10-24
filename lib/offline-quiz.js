'use strict';
/**
 * lib/offline-quiz.js
 * ---------------------------------------------------------------------------
 * Tao MOT file HTML tu chay (khong can server/mang) tu danh sach cau hoi da
 * duoc giao vien xac nhan. File gom 2 che do:
 *   - practice: on tap, lam lai theo so luot giao vien dat (0 = khong gioi han)
 *   - exam:     thi mot lan, co the dat thoi gian va tu dong nop khi het gio
 *
 * Diem duoc cham ngay trong trinh duyet theo dung quy tac cua lib/grading.js
 * (single/multi dung het moi duoc diem; truefalse chia theo so y dung; short
 * answer so sanh gia tri so). Trang thai lam bai luu o localStorage.
 *
 * GIOI HAN DA BIET: dap an nam trong file. File phu hop de giao vien gui hoc
 * sinh tu on/tu lam; khong chong duoc hoc sinh doc source.
 */

var crypto = require('crypto');
var katex = require('katex');

function normalizePoints(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 1;
    if (n > 100) return 100;
    return Math.round(n * 100) / 100;
}

function clampInt(v, def, min, max) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = def;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
}

function normalizeSettings(raw) {
    raw = raw || {};
    var mode = raw.mode === 'practice' ? 'practice' : 'exam';
    return {
        mode: mode,
        // Thi chi 1 luot; on tap moi co so luot (0 = khong gioi han).
        attempts: mode === 'practice' ? clampInt(raw.attempts, 0, 0, 99) : 1,
        minutes: mode === 'exam' ? clampInt(raw.minutes, 0, 0, 600) : 0,
        showAnswers: raw.showAnswers !== false,
        // Moi luot lam lai xao lai thu tu cau hoi (mac dinh bat).
        shuffle: raw.shuffle !== false
    };
}

// ========== CONG THUC TOAN: render san sang MathML ==========
// Khong nhung KaTeX vao file (nang ~1 MB va phai kem font). MathML trinh duyet
// hien dai tu render duoc, giu file offline gon va khong phu thuoc mang.
var ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
function decodeEntities(s) {
    return String(s).replace(/&(?:lt|gt|amp|quot|#39|nbsp);/g, function (m) { return ENTITIES[m]; });
}

function renderMathInHtml(html) {
    if (typeof html !== 'string' || (!/\\\(|\\\[/.test(html))) return html || '';
    return html.replace(/(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g, function (full) {
        var display = full.slice(0, 2) === '\\[';
        var tex = decodeEntities(full.slice(2, -2));
        try {
            return katex.renderToString(tex, {
                output: 'mathml',
                displayMode: display,
                throwOnError: false
            });
        } catch (e) {
            return full;
        }
    });
}

function cleanQuestion(q) {
    q = q || {};
    var type = ['single', 'multi', 'truefalse', 'shortanswer'].indexOf(q.type) >= 0 ? q.type : 'single';
    var options = Array.isArray(q.options) ? q.options.map(function (o) {
        return renderMathInHtml(String(o == null ? '' : o));
    }) : [];
    return {
        type: type,
        question: renderMathInHtml(String(q.question == null ? '' : q.question)),
        options: type === 'shortanswer' ? [] : options,
        correct: typeof q.correct === 'number' ? q.correct : -1,
        correctList: Array.isArray(q.correctList) ? q.correctList.slice() : [],
        correctTF: Array.isArray(q.correctTF) ? q.correctTF.slice() : [],
        correctAnswer: q.correctAnswer == null ? '' : String(q.correctAnswer),
        points: normalizePoints(q.points)
    };
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// Thu tu cau hoi cua mot luot lam. Ham thuan tuy de test duoc; file offline
// nhan ham nay qua tham so nen khong phu thuoc bien ngoai.
function buildOrder(count, shuffle, rng) {
    var order = [];
    for (var i = 0; i < count; i++) order.push(i);
    if (!shuffle) return order;
    rng = rng || Math.random;
    for (var j = order.length - 1; j > 0; j--) {
        var k = Math.floor(rng() * (j + 1));
        var tmp = order[j];
        order[j] = order[k];
        order[k] = tmp;
    }
    return order;
}

// ========== GIAO DIEN + MA CHAY TRONG FILE OFFLINE ==========
var CSS = `
:root{
  --bg:#eef2f8;--card:#fff;--ink:#172033;--muted:#5b6577;--line:#dbe2ee;
  --brand:#4338ca;--brand-soft:#eef0ff;--ok:#15803d;--ok-soft:#e8f7ee;
  --bad:#b91c1c;--bad-soft:#fdeaea;--warn:#b45309;--warn-soft:#fff6e5;
  --shadow:0 10px 30px rgba(23,32,51,.08)
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}
#app{max-width:880px;margin:0 auto;padding:20px 16px 96px}
h1,h2,h3{margin:0;line-height:1.25}
p{margin:.4em 0}
.kicker{font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;color:var(--brand);font-weight:800}
.title{font-size:1.55rem;margin:6px 0 8px;letter-spacing:-.01em}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}
.start{padding:28px}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 4px}
.chip{background:var(--brand-soft);color:var(--brand);border:1px solid #d9dcfa;border-radius:99px;padding:4px 12px;font-size:.82rem;font-weight:700}
.panel{background:#f8faff;border:1px solid var(--line);border-radius:14px;padding:16px;margin:18px 0}
.field{display:block;font-size:.86rem;font-weight:700;color:var(--muted)}
.field .input{margin-top:6px}
.input{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font:inherit;background:#fff;color:var(--ink)}
.input:focus,.short:focus{outline:2px solid var(--brand);outline-offset:1px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:11px 20px;border-radius:12px;border:1px solid var(--line);background:#fff;color:var(--ink);font:inherit;font-weight:800;cursor:pointer;text-decoration:none}
.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
.btn.primary:hover{background:#3730a3}
.btn.primary:disabled{background:#b9bdd6;border-color:#b9bdd6;cursor:not-allowed}
.btn.ghost{background:#f4f6fb}
.btn.block{width:100%;margin-top:18px}
.note{font-size:.86rem;color:var(--muted)}
.warnbox{background:var(--warn-soft);border:1px solid #f6d9a8;color:#7c4a03;border-radius:12px;padding:12px 14px;font-size:.9rem;margin-top:16px}
.quizhead{position:sticky;top:8px;z-index:5;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.quizhead h1{font-size:1.02rem}
.timer{font-variant-numeric:tabular-nums;font-weight:900;font-size:1.12rem;background:var(--brand-soft);color:var(--brand);padding:6px 12px;border-radius:10px;white-space:nowrap}
.timer.low{background:var(--bad-soft);color:var(--bad)}
.progress{height:8px;background:#e3e8f3;border-radius:99px;overflow:hidden;margin:14px 2px 5px}
.progress>i{display:block;height:100%;width:100%;background:var(--brand);transform:scaleX(0);transform-origin:left;transition:transform .2s}
.progressmeta{display:flex;justify-content:space-between;gap:10px;font-size:.82rem;color:var(--muted);margin:0 2px 6px}
.q{padding:18px;margin:14px 0}
.qhead{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}
.qnum{font-weight:900;color:var(--brand)}
.qpts{font-size:.78rem;color:var(--muted);white-space:nowrap}
.q-text p{margin:.35em 0}
.q-text img,.rev img,.opt img{max-width:100%;height:auto;border-radius:8px}
.opts{display:grid;gap:9px;margin-top:14px}
.opt{display:flex;gap:10px;align-items:flex-start;border:1.5px solid var(--line);border-radius:12px;padding:11px 13px;cursor:pointer;background:#fff}
.opt:hover{border-color:#b9c3da;background:#fbfcff}
.opt input{margin-top:4px;accent-color:var(--brand);flex:none}
.opt .letter{font-weight:900;color:var(--brand);min-width:1.2em}
.opt .txt{min-width:0}
.opt:has(input:checked){border-color:var(--brand);background:var(--brand-soft)}
.tf{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;align-items:center;border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:8px}
.tf-text{flex:1 1 300px;min-width:0}
.tf-choice{display:flex;gap:6px;flex:none}
.tf-choice label{border:1.5px solid var(--line);border-radius:9px;padding:6px 13px;font-size:.88rem;cursor:pointer;background:#fff;white-space:nowrap}
.tf-choice label:has(input:checked){border-color:var(--brand);background:var(--brand-soft);font-weight:800}
.tf-choice input{position:absolute;opacity:0;pointer-events:none}
.short{width:100%;max-width:340px;padding:11px 13px;border:1.5px solid var(--line);border-radius:12px;font:inherit;margin-top:12px;background:#fff}
.bottombar{position:fixed;left:0;right:0;bottom:0;z-index:20;background:rgba(255,255,255,.96);border-top:1px solid var(--line);padding:10px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px;backdrop-filter:blur(8px)}
.bottombar .count{font-size:.86rem;color:var(--muted)}
.btn.submit{background:var(--brand);color:#fff;border:0;border-radius:12px;padding:12px 24px;font:inherit;font-weight:900;cursor:pointer;min-height:48px}
.btn.submit:hover{background:#3730a3}
.result{padding:26px}
.bigscore{font-size:2.7rem;font-weight:900;letter-spacing:-.03em;line-height:1.1}
.bigscore small{font-size:1rem;color:var(--muted);font-weight:700}
.scoreline{display:flex;flex-wrap:wrap;gap:22px;align-items:center;margin:16px 0}
.stats{display:flex;flex-wrap:wrap;gap:8px}
.stat{background:#f4f6fb;border:1px solid var(--line);border-radius:10px;padding:6px 10px;font-size:.84rem;font-weight:700}
.stat.ok{background:var(--ok-soft);color:var(--ok);border-color:#bbebc9}
.stat.bad{background:var(--bad-soft);color:var(--bad);border-color:#f3c6c6}
.stat.warn{background:var(--warn-soft);color:var(--warn);border-color:#f0d6a4}
.rev-slot{padding-top:2px}
.rev-title{font-size:1.02rem;margin-bottom:4px}
.rev-filter{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
.rev-tab{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:99px;padding:5px 11px;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer}
.rev-tab span{color:var(--muted);font-weight:800}
.rev-tab.on{background:var(--brand);border-color:var(--brand);color:#fff}
.rev-tab.on span{color:#dfe2ff}
.rev-item{padding:14px 0;border-top:1px solid var(--line)}
.rev-item:first-of-type{border-top:0;padding-top:10px}
.rev-top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}
.badge{font-size:.75rem;font-weight:900;padding:2px 9px;border-radius:99px;white-space:nowrap}
.badge.ok{background:var(--ok-soft);color:var(--ok)}
.badge.part{background:var(--warn-soft);color:var(--warn)}
.badge.bad{background:var(--bad-soft);color:var(--bad)}
.badge.mute{background:#eef1f7;color:var(--muted)}
.rev-opt{display:flex;gap:8px;padding:6px 9px;border-radius:8px;margin-top:4px;align-items:flex-start;flex-wrap:wrap}
.rev-opt.is-correct{background:var(--ok-soft)}
.rev-opt.is-wrong{background:var(--bad-soft)}
.tag{font-size:.72rem;font-weight:800;padding:1px 7px;border-radius:99px;background:#fff;border:1px solid currentColor}
.tag.ok{color:var(--ok)}
.tag.bad{color:var(--bad)}
.tag.pick{color:var(--brand)}
.answerline{font-size:.9rem;margin-top:8px;color:var(--muted)}
.answerline b{color:var(--ink)}
.result-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.hist{margin-top:16px;padding:18px}
.hist-title{font-size:1.02rem;display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.hist-count{font-size:.8rem;color:var(--muted);font-weight:700}
.run{border:1px solid var(--line);border-radius:10px;background:#fff;margin-top:8px}
.run>summary{cursor:pointer;padding:9px 12px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:.9rem}
.run>summary::-webkit-details-marker{display:none}
.run>summary::before{content:'▸';color:var(--brand);font-weight:900}
.run[open]>summary::before{content:'▾'}
.run-no{font-weight:800}
.run-score{font-weight:800;font-variant-numeric:tabular-nums}
.run-at{margin-left:auto;color:var(--muted);font-size:.8rem;font-variant-numeric:tabular-nums}
.run-body{padding:0 12px 12px 30px}
.run-meta{font-size:.84rem;color:var(--muted);margin-bottom:4px}
@media (max-width:560px){
  #app{padding:12px 10px 92px}
  .start,.result{padding:20px}
  .q{padding:14px}
  .title{font-size:1.3rem}
  .quizhead{padding:12px 14px;top:6px}
  .bottombar{padding:9px 10px}
  .bottombar .count{max-width:45%}
  .btn.submit{padding:11px 18px}
}
@media print{
  body{background:#fff}
  #app{max-width:none;padding:0}
  .bottombar,.result-actions{display:none}
  .quizhead{position:static;box-shadow:none}
}
`;

// Ham nay duoc chuyen thanh source va nhung vao file HTML. Viet nhu code
// trinh duyet binh thuong de de doc; khong tham chieu bien ngoai.
function clientApp(buildOrder) {
    'use strict';

    var DATA = JSON.parse(document.getElementById('quiz-data').textContent);
    var QS = DATA.questions || [];
    var CFG = DATA.settings || {};
    var app = document.getElementById('app');
    var KEY = 'offlineQuiz:' + DATA.id;
    var MAX_ATTEMPTS = CFG.mode === 'practice' ? (CFG.attempts || 0) : 1;
    var timerId = null;
    var state = readState();

    function readState() {
        try {
            var raw = JSON.parse(localStorage.getItem(KEY));
            if (raw && typeof raw === 'object') {
                raw.runs = Array.isArray(raw.runs) ? raw.runs : [];
                return raw;
            }
        } catch (e) {}
        return { runs: [] };
    }

    function writeState() {
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    }

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function pointsOf(q) {
        var n = Number(q.points);
        if (!isFinite(n) || n <= 0) return 1;
        return Math.min(n, 100);
    }

    function round2(n) { return Math.round(n * 100) / 100; }
    function fmtNum(n) { return String(round2(n)).replace('.', ','); }
    function letter(i) { return String.fromCharCode(65 + i); }

    // So sanh dap an tra loi ngan giong lib/short-answer.js (so nguyen/thap phan).
    function normNum(v) {
        if (typeof v !== 'string' && typeof v !== 'number') return null;
        var s = String(v).trim();
        if (!s || s.length > 50) return null;
        s = s.replace(',', '.');
        var m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
        if (!m) return null;
        var intPart = m[2] || '';
        var frac = m[3] || '';
        if (!intPart && !frac) return null;
        intPart = intPart.replace(/^0+/, '') || '0';
        frac = frac.replace(/0+$/, '');
        var neg = m[1] === '-' && !(intPart === '0' && frac === '');
        return (neg ? '-' : '') + intPart + (frac ? '.' + frac : '');
    }

    function numEquals(a, b) {
        var x = normNum(a), y = normNum(b);
        return !!x && x === y;
    }

    function scoreQuestion(q, ans) {
        if (q.type === 'single') return ans === q.correct ? 1 : 0;
        if (q.type === 'multi') {
            var given = Array.isArray(ans) ? ans.slice().sort(function (a, b) { return a - b; }) : [];
            var right = Array.isArray(q.correctList) ? q.correctList.slice().sort(function (a, b) { return a - b; }) : [];
            if (given.length !== right.length || !given.length) return 0;
            for (var i = 0; i < given.length; i++) if (given[i] !== right[i]) return 0;
            return 1;
        }
        if (q.type === 'truefalse') {
            var correct = 0;
            var total = (q.correctTF || []).length;
            if (!total) return 0;
            for (var j = 0; j < total; j++) {
                if (Array.isArray(ans) && ans[j] === q.correctTF[j]) correct++;
            }
            if (total === 4) return [0, 0.1, 0.25, 0.5, 1][correct];
            return correct / total;
        }
        if (q.type === 'shortanswer') return numEquals(ans, q.correctAnswer) ? 1 : 0;
        return 0;
    }

    function hasAnyAnswer(q, a) {
        if (q.type === 'single') return typeof a === 'number' && a >= 0;
        if (q.type === 'multi') return Array.isArray(a) && a.length > 0;
        if (q.type === 'truefalse') return Array.isArray(a) && a.some(function (v) { return v === true || v === false; });
        return String(a == null ? '' : a).trim() !== '';
    }

    function isComplete(q, a) {
        if (q.type === 'single') return typeof a === 'number' && a >= 0;
        if (q.type === 'multi') return Array.isArray(a) && a.length > 0;
        if (q.type === 'truefalse') {
            return Array.isArray(a) && a.length === (q.options || []).length &&
                a.every(function (v) { return v === true || v === false; });
        }
        return String(a == null ? '' : a).trim() !== '';
    }

    function computeResult(answers) {
        var score = 0, max = 0, correct = 0, partial = 0, wrong = 0, unanswered = 0;
        QS.forEach(function (q, i) {
            var pts = pointsOf(q);
            var ratio = scoreQuestion(q, answers[i]);
            max += pts;
            score += ratio * pts;
            if (ratio === 1) correct++;
            else if (!hasAnyAnswer(q, answers[i])) unanswered++;
            else if (ratio > 0) partial++;
            else wrong++;
        });
        return {
            score: round2(score), maxScore: round2(max),
            correct: correct, partial: partial, wrong: wrong, unanswered: unanswered
        };
    }

    function canStart() {
        return MAX_ATTEMPTS === 0 || state.runs.length < MAX_ATTEMPTS;
    }

    function clearedTimer() {
        if (timerId) { clearInterval(timerId); timerId = null; }
    }

    function fmtTime(ms) {
        var s = Math.max(0, Math.ceil(ms / 1000));
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = s % 60;
        function two(n) { return (n < 10 ? '0' : '') + n; }
        return (h ? h + ':' : '') + two(m) + ':' + two(sec);
    }

    function fmtDate(ts) {
        var d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        function two(n) { return (n < 10 ? '0' : '') + n; }
        return two(d.getHours()) + ':' + two(d.getMinutes()) + ' ' +
            two(d.getDate()) + '/' + two(d.getMonth() + 1) + '/' + d.getFullYear();
    }

    // Moi luot la mot <details> thu gon; bai lam chi duoc ve khi mo dung luot do.
    function renderHistory(openLatest) {
        if (!state.runs.length) return '';
        var rows = state.runs.map(function (run, idx) {
            var key = 'run' + idx;
            var hasAnswers = CFG.showAnswers && run.answers && typeof run.answers === 'object';
            var meta = [];
            if (run.name) meta.push(esc(run.name));
            if (run.timedOut) meta.push('Hết giờ');
            if (typeof run.correct === 'number') meta.push('Đúng ' + run.correct + ' · Sai ' + run.wrong);
            var body = '<div class="run-body">' +
                (meta.length ? '<div class="run-meta">' + meta.join(' · ') + '</div>' : '') +
                (hasAnswers
                    ? reviewSlot(key, run.answers, orderOf(run))
                    : '<p class="note">' + (CFG.showAnswers ? 'Lượt này chỉ lưu điểm, không có chi tiết bài làm.' : 'Đáp án và chi tiết bài làm do giáo viên giữ.') + '</p>') +
                '</div>';
            return '<details class="run"' + (hasAnswers ? ' data-rev-key="' + key + '"' : '') +
                (openLatest && idx === state.runs.length - 1 ? ' open' : '') + '>' +
                '<summary>' +
                    '<span class="run-no">Lần ' + (idx + 1) + '</span>' +
                    '<span class="run-score">' + fmtNum(run.score) + '/' + fmtNum(run.maxScore) + ' điểm</span>' +
                    '<span class="run-at">' + fmtDate(run.at) + '</span>' +
                '</summary>' + body + '</details>';
        }).reverse().join('');

        return '<div class="card hist"><h2 class="hist-title">Lịch sử làm bài' +
            '<span class="hist-count">' + state.runs.length + ' lượt</span></h2>' +
            '<p class="note" style="margin-top:4px">Bấm vào một lượt để xem chi tiết bài làm.</p>' +
            rows + '</div>';
    }

    // ===== Xem lai bai lam (dung chung cho lich su va ket qua) =====
    // reviewState: key -> { answers, order, filter }
    var reviewState = {};

    var FILTERS = [
        ['all', 'Tất cả'], ['ok', 'Đúng'], ['part', 'Đúng một phần'],
        ['bad', 'Sai'], ['mute', 'Chưa trả lời']
    ];

    function orderOf(run) {
        if (run && Array.isArray(run.order) && run.order.length === QS.length) return run.order;
        var order = [];
        for (var i = 0; i < QS.length; i++) order.push(i);
        return order;
    }

    function reviewSlot(key, answers, order) {
        reviewState[key] = {
            answers: answers || {},
            order: order,
            filter: reviewState[key] ? reviewState[key].filter : 'all'
        };
        return '<div class="rev-slot" data-rev="' + key + '"></div>';
    }

    function reviewItem(q, num, a, info) {
        return '<div class="rev-item">' +
            '<div class="rev-top"><span class="qnum">Câu ' + num + '</span>' +
                '<span class="badge ' + info.cls + '">' + info.text + '</span></div>' +
            '<div class="q-text">' + q.question + '</div>' +
            reviewOptions(q, a) +
        '</div>';
    }

    function fillReview(key) {
        var st = reviewState[key];
        var slot = st ? document.querySelector('[data-rev="' + key + '"]') : null;
        if (!slot) return;

        var counts = { all: 0, ok: 0, part: 0, bad: 0, mute: 0 };
        var items = st.order.map(function (qi, pos) {
            var q = QS[qi];
            if (!q) return '';
            var a = st.answers[qi];
            var info = statusInfo(q, a);
            counts.all++;
            counts[info.cls]++;
            if (st.filter !== 'all' && st.filter !== info.cls) return '';
            return reviewItem(q, pos + 1, a, info);
        }).join('');

        var tabs = FILTERS.map(function (f) {
            return '<button type="button" class="rev-tab' + (st.filter === f[0] ? ' on' : '') + '"' +
                ' data-rev-key="' + key + '" data-rev-filter="' + f[0] + '">' +
                f[1] + ' <span>' + counts[f[0]] + '</span></button>';
        }).join('');

        slot.innerHTML =
            '<h2 class="rev-title">Xem lại bài làm</h2>' +
            '<div class="rev-filter" role="group" aria-label="Lọc câu theo kết quả">' + tabs + '</div>' +
            (items || '<p class="note">Không có câu nào trong nhóm này.</p>');
    }

    // Mo luot nao moi ve bai lam cua luot do (khong dung san HTML cho tat ca).
    function wireReviews() {
        var list = document.querySelectorAll('details.run[data-rev-key]');
        for (var i = 0; i < list.length; i++) {
            (function (d) {
                var key = d.getAttribute('data-rev-key');
                if (d.open) fillReview(key);
                d.ontoggle = function () { if (d.open) fillReview(key); };
            })(list[i]);
        }
    }


    function renderStart() {
        clearedTimer();
        var used = state.runs.length;
        var blocked = !canStart();
        var modeText = CFG.mode === 'practice' ? 'Ôn tập' : 'Thi';
        var rules = [];
        if (CFG.mode === 'practice') {
            rules.push(MAX_ATTEMPTS > 0 ? 'Tối đa ' + MAX_ATTEMPTS + ' lượt làm bài.' : 'Được làm lại không giới hạn số lần.');
        } else {
            rules.push('Chỉ làm một lần. Nộp bài xong không làm lại.');
        }
        if (CFG.mode === 'exam' && CFG.minutes > 0) {
            rules.push('Thời gian làm bài ' + CFG.minutes + ' phút; hết giờ hệ thống tự nộp.');
        }
        if (CFG.shuffle) rules.push('Thứ tự câu hỏi được xáo trộn ở mỗi lượt làm.');
        rules.push(CFG.showAnswers ? 'Sau khi nộp, xem được đáp án đúng và bài làm của mình.' : 'Sau khi nộp, chỉ xem điểm; đáp án do giáo viên giữ.');

        app.innerHTML =
            '<div class="card start">' +
                '<div class="kicker">Bài kiểm tra ' + (CFG.mode === 'practice' ? 'ôn tập' : 'trực tuyến (offline)') + '</div>' +
                '<h1 class="title">' + esc(DATA.title) + '</h1>' +
                '<div class="meta">' +
                    '<span class="chip">' + QS.length + ' câu</span>' +
                    '<span class="chip">' + fmtNum(QS.reduce(function (s, q) { return s + pointsOf(q); }, 0)) + ' điểm</span>' +
                    '<span class="chip">' + modeText + '</span>' +
                    (CFG.mode === 'exam' && CFG.minutes > 0 ? '<span class="chip">' + CFG.minutes + ' phút</span>' : '') +
                    (CFG.mode === 'practice' && MAX_ATTEMPTS > 0 ? '<span class="chip">' + used + '/' + MAX_ATTEMPTS + ' lượt đã làm</span>' : '') +
                '</div>' +
                '<div class="panel">' +
                    '<label class="field">Họ và tên (không bắt buộc)' +
                        '<input id="studentName" class="input" maxlength="80" autocomplete="off" placeholder="Nhập họ tên để hiện trên kết quả" value="' + esc(state.name || '') + '">' +
                    '</label>' +
                '</div>' +
                '<div class="note"><b>Thể lệ</b><br>' + rules.map(function (r) { return '• ' + r; }).join('<br>') + '</div>' +
                (blocked ? '<div class="warnbox">Bạn đã dùng hết ' + MAX_ATTEMPTS + ' lượt làm bài của đề này.</div>' : '') +
                '<button id="startBtn" class="btn primary block" ' + (blocked ? 'disabled' : '') + '>' +
                    (blocked ? 'Đã hết lượt' : 'Bắt đầu làm bài') +
                '</button>' +
            '</div>' +
            renderHistory(false);
        wireReviews();

        var btn = document.getElementById('startBtn');
        if (btn && !blocked) btn.onclick = function () {
            var nameEl = document.getElementById('studentName');
            var name = nameEl ? nameEl.value.trim() : '';
            state.name = name;
            state.last = null;
            state.current = {
                startedAt: Date.now(),
                name: name,
                answers: {},
                order: buildOrder(QS.length, CFG.shuffle),
                deadline: (CFG.mode === 'exam' && CFG.minutes > 0) ? Date.now() + CFG.minutes * 60000 : null
            };
            writeState();
            showQuiz();
        };
    }

    // qi = chi so goc cua cau (khoa dap an), pos = vi tri hien thi trong luot lam.
    function renderQuestion(q, qi, pos) {
        var a = state.current && state.current.answers ? state.current.answers[qi] : undefined;
        var body = '';

        if (q.type === 'single') {
            body = '<div class="opts">' + q.options.map(function (o, oi) {
                return '<label class="opt"><input type="radio" data-role="single" data-qi="' + qi + '" data-oi="' + oi + '" name="s_' + qi + '" value="' + oi + '" ' + (a === oi ? 'checked' : '') + '>' +
                    '<span class="letter">' + letter(oi) + '.</span><span class="txt">' + o + '</span></label>';
            }).join('') + '</div>';
        } else if (q.type === 'multi') {
            var picked = Array.isArray(a) ? a : [];
            body = '<div class="opts">' + q.options.map(function (o, oi) {
                return '<label class="opt"><input type="checkbox" data-role="multi" data-qi="' + qi + '" data-oi="' + oi + '" ' + (picked.indexOf(oi) >= 0 ? 'checked' : '') + '>' +
                    '<span class="letter">' + letter(oi) + '.</span><span class="txt">' + o + '</span></label>';
            }).join('') + '</div>';
        } else if (q.type === 'truefalse') {
            var tf = Array.isArray(a) ? a : [];
            body = q.options.map(function (o, oi) {
                var v = tf[oi];
                return '<div class="tf"><div class="tf-text"><b>' + 'abcd'.charAt(oi) + ')</b> ' + o + '</div>' +
                    '<div class="tf-choice">' +
                        '<label><input type="radio" data-role="tf" data-qi="' + qi + '" data-oi="' + oi + '" name="tf_' + qi + '_' + oi + '" value="true" ' + (v === true ? 'checked' : '') + '>Đúng</label>' +
                        '<label><input type="radio" data-role="tf" data-qi="' + qi + '" data-oi="' + oi + '" name="tf_' + qi + '_' + oi + '" value="false" ' + (v === false ? 'checked' : '') + '>Sai</label>' +
                    '</div></div>';
            }).join('');
        } else {
            body = '<input type="text" class="short" inputmode="decimal" data-role="short" data-qi="' + qi + '" ' +
                'value="' + esc(a || '') + '" placeholder="Nhập đáp án (số nguyên hoặc số thập phân)">';
        }

        return '<section class="card q" id="q' + qi + '">' +
            '<div class="qhead"><span class="qnum">Câu ' + (pos + 1) + '</span>' +
                '<span class="qpts">' + fmtNum(pointsOf(q)) + ' điểm</span></div>' +
            '<div class="q-text">' + q.question + '</div>' + body +
        '</section>';
    }

    function showQuiz() {
        if (!state.current) { renderStart(); return; }
        clearedTimer();
        var order = orderOf(state.current);
        var nameLine = state.current.name ? ' · ' + esc(state.current.name) : '';
        var timer = (CFG.mode === 'exam' && CFG.minutes > 0) ? '<div class="timer" id="timer">--:--</div>' : '';
        app.innerHTML =
            '<div class="quizhead"><div><div class="kicker">' + (CFG.mode === 'practice' ? 'Ôn tập' : 'Thi') + nameLine + '</div>' +
                '<h1>' + esc(DATA.title) + '</h1></div>' + timer + '</div>' +
            '<div class="progress"><i id="progBar"></i></div>' +
            '<div class="progressmeta"><span id="progText">Đã trả lời 0/' + QS.length + ' câu</span><span>' +
                (CFG.mode === 'practice' ? 'Làm lại được' : 'Chỉ một lượt') + '</span></div>' +
            order.map(function (qi, pos) { return renderQuestion(QS[qi], qi, pos); }).join('') +
            '<div class="bottombar"><span class="count" id="botText">0/' + QS.length + ' câu</span>' +
                '<button class="btn submit" id="submitBtn">Nộp bài</button></div>';

        document.getElementById('submitBtn').onclick = function () { submit(false); };
        updateProgress();
        startTimer();
    }

    function updateProgress() {
        if (!state.current) return;
        var done = 0;
        QS.forEach(function (q, i) {
            if (isComplete(q, state.current.answers[i])) done++;
        });
        var bar = document.getElementById('progBar');
        var text = document.getElementById('progText');
        var bot = document.getElementById('botText');
        var pct = QS.length ? Math.round(done / QS.length * 100) : 0;
        if (bar) bar.style.transform = 'scaleX(' + (pct / 100) + ')';
        if (text) text.textContent = 'Đã trả lời ' + done + '/' + QS.length + ' câu';
        if (bot) bot.textContent = done + '/' + QS.length + ' câu';
    }

    function onAnswer(e) {
        if (!state.current) return;
        var t = e.target;
        var role = t.getAttribute && t.getAttribute('data-role');
        if (!role) return;
        var qi = parseInt(t.getAttribute('data-qi'), 10);
        if (!(qi >= 0 && qi < QS.length)) return;
        var oi = parseInt(t.getAttribute('data-oi'), 10);
        var answers = state.current.answers;

        if (role === 'single') {
            answers[qi] = oi;
        } else if (role === 'multi') {
            var list = Array.isArray(answers[qi]) ? answers[qi].slice() : [];
            if (t.checked) { if (list.indexOf(oi) < 0) list.push(oi); }
            else list = list.filter(function (x) { return x !== oi; });
            list.sort(function (a, b) { return a - b; });
            answers[qi] = list;
        } else if (role === 'tf') {
            var tf = Array.isArray(answers[qi]) ? answers[qi].slice() : [];
            var need = (QS[qi].options || []).length;
            while (tf.length < need) tf.push(null);
            tf[oi] = t.value === 'true';
            answers[qi] = tf;
        } else if (role === 'short') {
            answers[qi] = t.value;
        } else {
            return;
        }
        writeState();
        updateProgress();
    }

    function startTimer() {
        clearedTimer();
        if (CFG.mode !== 'exam' || !CFG.minutes || !state.current) return;
        tick();
        timerId = setInterval(tick, 1000);

        function tick() {
            if (!state.current) { clearedTimer(); return; }
            var left = state.current.deadline - Date.now();
            var el = document.getElementById('timer');
            if (left <= 0) { clearedTimer(); submit(true); return; }
            if (el) {
                el.textContent = fmtTime(left);
                el.className = 'timer' + (left < 60000 ? ' low' : '');
            }
        }
    }

    function submit(auto) {
        if (!state.current) return;
        var order = orderOf(state.current);
        if (!auto) {
            var missing = [];
            order.forEach(function (qi, pos) {
                if (!isComplete(QS[qi], state.current.answers[qi])) missing.push(pos + 1);
            });
            if (missing.length) {
                var sample = missing.slice(0, 12).join(', ') + (missing.length > 12 ? '…' : '');
                if (!confirm('Còn ' + missing.length + ' câu chưa trả lời (câu ' + sample + ').\nVẫn nộp bài?')) return;
            } else if (!confirm('Nộp bài? Sau khi nộp sẽ không sửa được nữa.')) {
                return;
            }
        }
        clearedTimer();
        var answers = state.current.answers;
        var res = computeResult(answers);
        var last = {
            answers: answers,
            at: Date.now(),
            name: state.current.name || '',
            timedOut: !!auto,
            score: res.score,
            maxScore: res.maxScore
        };
        state.last = last;
        state.runs.push({
            at: last.at, name: last.name, score: res.score, maxScore: res.maxScore,
            correct: res.correct, partial: res.partial, wrong: res.wrong,
            unanswered: res.unanswered, total: QS.length, timedOut: last.timedOut,
            order: order, answers: answers
        });
        // shortcut: chi giu bai lam 30 luot gan nhat de localStorage khong phinh.
        if (state.runs.length > 30) delete state.runs[state.runs.length - 31].answers;
        state.current = null;
        writeState();
        renderResult(last);
    }

    function statusInfo(q, a) {
        var ratio = scoreQuestion(q, a);
        if (ratio === 1) return { cls: 'ok', text: 'Đúng' };
        if (!hasAnyAnswer(q, a)) return { cls: 'mute', text: 'Chưa trả lời' };
        if (ratio > 0) return { cls: 'part', text: 'Đúng một phần' };
        return { cls: 'bad', text: 'Sai' };
    }

    function reviewOptions(q, a) {
        if (q.type === 'single') {
            return '<div class="opts">' + q.options.map(function (o, oi) {
                var cls = '';
                if (oi === q.correct) cls += ' is-correct';
                if (a === oi && oi !== q.correct) cls += ' is-wrong';
                return '<div class="rev-opt' + cls + '"><span class="letter">' + letter(oi) + '.</span><span class="txt">' + o + '</span>' +
                    (oi === q.correct ? '<span class="tag ok">Đáp án</span>' : '') +
                    (a === oi ? '<span class="tag pick">Bạn chọn</span>' : '') + '</div>';
            }).join('') + '</div>';
        }
        if (q.type === 'multi') {
            var picked = Array.isArray(a) ? a : [];
            var right = q.correctList || [];
            return '<div class="opts">' + q.options.map(function (o, oi) {
                var isRight = right.indexOf(oi) >= 0;
                var isPicked = picked.indexOf(oi) >= 0;
                var cls = isRight ? ' is-correct' : (isPicked ? ' is-wrong' : '');
                return '<div class="rev-opt' + cls + '"><span class="letter">' + letter(oi) + '.</span><span class="txt">' + o + '</span>' +
                    (isRight ? '<span class="tag ok">Đáp án</span>' : '') +
                    (isPicked ? '<span class="tag pick">Bạn chọn</span>' : '') + '</div>';
            }).join('') + '</div>' +
            '<div class="answerline">Đáp án: <b>' + (right.map(letter).join(', ') || '—') + '</b> · Bạn chọn: <b>' + (picked.map(letter).join(', ') || '—') + '</b></div>';
        }
        if (q.type === 'truefalse') {
            var tf = Array.isArray(a) ? a : [];
            return '<div class="opts">' + (q.options || []).map(function (o, oi) {
                var rightV = (q.correctTF || [])[oi];
                var pick = tf[oi];
                var isRight = pick === rightV;
                var cls = isRight ? ' is-correct' : (pick === null || pick === undefined ? '' : ' is-wrong');
                return '<div class="rev-opt' + cls + '"><span class="txt"><b>' + 'abcd'.charAt(oi) + ')</b> ' + o + '</span>' +
                    '<span class="tag ok">Đáp án: ' + (rightV ? 'Đúng' : 'Sai') + '</span>' +
                    '<span class="tag ' + (isRight ? 'ok' : 'bad') + '">Bạn chọn: ' + (pick === true ? 'Đúng' : pick === false ? 'Sai' : '—') + '</span></div>';
            }).join('') + '</div>';
        }
        var yours = String(a == null ? '' : a).trim();
        return '<div class="answerline">Đáp án: <b>' + esc(q.correctAnswer) + '</b> · Bạn trả lời: <b>' +
            (yours ? esc(yours) : '—') + '</b></div>';
    }

    function renderResult(last) {
        clearedTimer();
        var res = computeResult(last.answers);
        var pct = res.maxScore > 0 ? Math.round(res.score / res.maxScore * 100) : 0;
        var msg;
        if (CFG.mode === 'exam') {
            msg = last.timedOut
                ? 'Hết giờ làm bài. Điểm đã được ghi nhận trên máy này.'
                : 'Đã nộp bài. Điểm đã được ghi nhận trên máy này.';
        } else if (pct === 100) msg = 'Hoàn hảo! Bạn đã làm đúng toàn bộ bài.';
        else if (pct >= 80) msg = 'Rất tốt! Chỉ còn vài chỗ cần xem lại.';
        else if (pct >= 50) msg = 'Khá ổn. Hãy xem lại những câu còn sai để chắc kiến thức.';
        else msg = 'Đừng lo — xem lại đáp án và thử làm lại để tiến bộ.';

        var runText = '';
        if (CFG.mode === 'practice' && MAX_ATTEMPTS > 0) {
            runText = 'Lượt ' + state.runs.length + '/' + MAX_ATTEMPTS;
        }

        var actions = '';
        if (canStart()) {
            actions += '<button class="btn primary" id="retryBtn">Làm lại</button>';
        }
        actions += '<button class="btn ghost" id="homeBtn">Về trang đầu</button>';

        app.innerHTML =
            '<div class="card result">' +
                '<div class="kicker">Kết quả ' + (CFG.mode === 'practice' ? 'ôn tập' : 'bài thi') + (runText ? ' · ' + esc(runText) : '') + '</div>' +
                '<h1 class="title">' + esc(DATA.title) + '</h1>' +
                (last.name ? '<div class="note">Học sinh: <b>' + esc(last.name) + '</b></div>' : '') +
                (last.timedOut ? '<div class="warnbox">Hết giờ — bài đã được tự động nộp.</div>' : '') +
                '<div class="scoreline">' +
                    '<div class="bigscore">' + fmtNum(res.score) + ' <small>/ ' + fmtNum(res.maxScore) + ' điểm</small></div>' +
                    '<div class="stats">' +
                        '<span class="stat">' + pct + '%</span>' +
                        '<span class="stat ok">Đúng ' + res.correct + '</span>' +
                        (res.partial ? '<span class="stat warn">Đúng một phần ' + res.partial + '</span>' : '') +
                        '<span class="stat bad">Sai ' + res.wrong + '</span>' +
                        '<span class="stat">Chưa trả lời ' + res.unanswered + '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="note">' + msg + '</div>' +
                '<div class="note" style="margin-top:10px;">Chụp màn hình kết quả này để gửi giáo viên (nếu được yêu cầu).</div>' +
                '<div class="result-actions">' + actions + '</div>' +
            '</div>' +
            renderHistory(true);
        wireReviews();

        var retry = document.getElementById('retryBtn');
        if (retry) retry.onclick = function () {
            if (!canStart()) { renderStart(); return; }
            state.last = null;
            state.current = {
                startedAt: Date.now(),
                name: state.name || last.name || '',
                answers: {},
                order: buildOrder(QS.length, CFG.shuffle),
                deadline: (CFG.mode === 'exam' && CFG.minutes > 0) ? Date.now() + CFG.minutes * 60000 : null
            };
            writeState();
            showQuiz();
        };
        var home = document.getElementById('homeBtn');
        if (home) home.onclick = renderStart;
    }

    app.addEventListener('change', onAnswer);
    app.addEventListener('input', onAnswer);

    // Bo loc trong bai lam: moi nut loc chi ve lai phan xem lai cua dung luot do.
    app.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-rev-filter]') : null;
        if (!btn) return;
        var key = btn.getAttribute('data-rev-key');
        if (!reviewState[key]) return;
        reviewState[key].filter = btn.getAttribute('data-rev-filter');
        fillReview(key);
    });

    // Khoi dong: dang lam -> tiep tuc; da nop -> xem ket qua; chua lam -> trang dau.
    if (state.current) {
        if (state.current.deadline && Date.now() >= state.current.deadline) {
            submit(true);
        } else {
            showQuiz();
        }
    } else if (state.last) {
        renderResult(state.last);
    } else {
        renderStart();
    }
}

function renderQuiz(input) {
    input = input || {};
    var settings = normalizeSettings(input.settings);
    var title = String(input.title == null ? '' : input.title).replace(/[<>]/g, '').trim().slice(0, 100) || 'Bài kiểm tra';
    var questions = (Array.isArray(input.questions) ? input.questions : []).map(cleanQuestion);
    var data = { v: 1, title: title, settings: settings, questions: questions };
    var id = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 12);
    data.id = id;

    // "<" -> \u003c de noi dung cau hoi khong the dong the <script>.
    var json = JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

    return '<!doctype html>\n<html lang="vi">\n<head>\n<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '<title>' + escapeHtml(title) + '</title>\n' +
        '<style>' + CSS + '</style>\n</head>\n<body>\n<div id="app"></div>\n' +
        '<script id="quiz-data" type="application/json">' + json + '</script>\n' +
        '<script>(' + clientApp.toString() + ')(' + buildOrder.toString() + ');</script>\n' +
        '</body>\n</html>\n';
}

module.exports = {
    renderQuiz: renderQuiz,
    normalizeSettings: normalizeSettings,
    renderMathInHtml: renderMathInHtml,
    buildOrder: buildOrder
};
