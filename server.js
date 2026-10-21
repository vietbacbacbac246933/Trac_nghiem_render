// Bat loi khong xu ly duoc
process.on('uncaughtException', function(err) {
    console.log('');
    console.log('LOI: ' + err.message);
    if (err.stack) {
        var lines = err.stack.split('\n');
        for (var i = 0; i < Math.min(lines.length, 5); i++) {
            console.log('  ' + lines[i]);
        }
    }
    console.log('');
});

var express = require('express');
var http = require('http');
var socketIO = require('socket.io');
var fs = require('fs');
var path = require('path');
var os = require('os');
var mammoth = require('mammoth');
var XLSX = require('xlsx');
var multer = require('multer');
var JSZip = require('jszip');
var xmljs = require('xml-js');

// Lop luu tru (PostgreSQL neu co DATABASE_URL, nguoc lai dung filesystem)
var DATA = require('./lib/datastore');
// Xac thuc giao vien
var auth = require('./lib/auth');
// Kiem tra dinh dang/dung luong file tai len (Nhap de tu Word/Anh)
var fileValidate = require('./lib/file-validate');
// Phien xem truoc khi nhap de (luu RAM, co TTL)
var importSessions = require('./lib/import-sessions');
// Chuan hoa dap an tra loi ngan (so nguyen/thap phan, khong sai so)
var shortAnswer = require('./lib/short-answer');
var answerTables = require('./lib/answer-tables');
// Kho anh tai len + quy tac noi dung cau hoi (sanitize, diem)
var assets = require('./lib/assets');
var questionContent = require('./lib/question-content');
var sanitizeHtml = questionContent.sanitizeHtml;
var parsePointsInput = questionContent.parsePointsInput;
// Danh sach on tap (nhieu de / hoc sinh tu chon)
var review = require('./lib/review');
// Cham diem dung chung cho Thi va On tap
var grading = require('./lib/grading');
var normalizePoints = grading.normalizePoints;
var scoreQuestion = grading.scoreQuestion;
// Logic che do On tap (gioi han luot, thoi gian, loc du lieu tra ve client)
var practice = require('./lib/practice');

// ========== HELPER FUNCTIONS CHO ES5 ==========
// Merge objects (thay thế spread operator)
function mergeObjects() {
    var result = {};
    for (var i = 0; i < arguments.length; i++) {
        var obj = arguments[i];
        if (obj) {
            var keys = Object.keys(obj);
            for (var j = 0; j < keys.length; j++) {
                result[keys[j]] = obj[keys[j]];
            }
        }
    }
    return result;
}

// Copy array (thay thế [...array])
function copyArray(arr) {
    var result = [];
    for (var i = 0; i < arr.length; i++) {
        result.push(arr[i]);
    }
    return result;
}

var APP_VERSION = '1.0.0';

// Cấu hình multer để lưu file trong memory.
// Giới hạn 15 MB cho các API cũ (Word/Excel/JSON) để tránh file lớn nằm toàn bộ trong RAM.
var upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: fileValidate.FILE_LIMITS.maxDocxBytes,
        files: 1
    }
});

// Multer riêng cho file Word: chỉ nhận .docx, tối đa 15 MB.
var docxUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: fileValidate.FILE_LIMITS.maxDocxBytes,
        files: 1
    },
    fileFilter: function (req, file, cb) {
        if (fileValidate.detectKind(file.originalname, file.mimetype) !== 'docx') {
            var err = new Error('Chỉ nhận file Word (.docx).');
            err.code = 'UNSUPPORTED_TYPE';
            return cb(err);
        }
        cb(null, true);
    }
});

// Multer riêng cho ảnh chèn trực tiếp vào câu hỏi.
var assetUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: fileValidate.FILE_LIMITS.maxImageBytes,
        files: 1
    },
    fileFilter: function (req, file, cb) {
        if (fileValidate.detectKind(file.originalname, file.mimetype) !== 'image') {
            var err = new Error('Chỉ nhận file ảnh (png, jpg, gif, bmp, webp).');
            err.code = 'UNSUPPORTED_TYPE';
            return cb(err);
        }
        cb(null, true);
    }
});

var app = express();
var server = http.createServer(app);
var io = socketIO(server, {
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// Render cap port dong qua bien moi truong PORT
var PORT = parseInt(process.env.PORT, 10) || 3456;

// Render dat ung dung sau proxy -> can trust proxy de req.ip dung
app.set('trust proxy', 1);

// Middleware
app.use(express.json({ limit: '2mb' }));

// Chuan hoa duong dan truoc khi so sanh: phai giai ma %xx, gop dau "/" thua,
// bo "/./" va bo phan biet chu HOA/thuong. Neu so sanh tho thi
// "//teacher.html" hoac "/%74eacher.html" se LOT QUA guard roi duoc
// express.static tra ve nguyen trang giao vien.
function normalizePath(p) {
    var s = String(p || '');
    for (var i = 0; i < 3; i++) {
        var before = s;
        try { s = decodeURIComponent(s); } catch (e) { break; }
        if (s === before) break;
    }
    return s.replace(/\\/g, '/').replace(/\/\.\//g, '/').replace(/\/+/g, '/').toLowerCase();
}

// Chan truy cap truc tiep /teacher.html (express.static se bo qua route /teacher)
app.use(function(req, res, next) {
    var p = normalizePath(req.path);
    if ((p === '/teacher.html' || p === '/teacher.htm') && !isTeacher(req)) {
        return res.redirect('/teacher/login');
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '0' }));

// Serve KaTeX cho render công thức toán (LAN - không cần internet)
app.use('/katex', express.static(path.join(__dirname, 'node_modules', 'katex', 'dist'), { maxAge: '7d' }));

// Serve CHỈ các file mẫu cho phép tải về.
// KHÔNG dùng express.static cho cả thư mục data/ vì data/questions.json và
// data/exams/*.json chứa đáp án chính thức -> học sinh có thể tải trực tiếp.
var DATA_DOWNLOADS = {
    'mau-cau-hoi.docx': true,
    'mau-cau-hoi.json': true
};
app.get('/data/:file', function(req, res) {
    var name = req.params.file;
    if (!Object.prototype.hasOwnProperty.call(DATA_DOWNLOADS, name)) {
        return res.status(404).end();
    }
    res.sendFile(path.join(__dirname, 'data', name), { maxAge: 0 });
});

// Kiểm tra quyền giáo viên: dựa trên cookie phiên đã đăng nhập.
// (Nếu chưa cấu hình TEACHER_PASSWORD, tạm cho phép localhost để chạy local.)
function isTeacher(req) {
    return auth.isAuthenticated(req);
}

function isSecureRequest(req) {
    if (req.secure) return true;
    var proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return proto === 'https';
}

// Route cho trang giáo viên - yêu cầu đăng nhập
app.get('/teacher', (req, res) => {
    if (!isTeacher(req)) {
        return res.redirect('/teacher/login');
    }
    res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

// Trang đăng nhập giáo viên
app.get('/teacher/login', (req, res) => {
    if (isTeacher(req)) return res.redirect('/teacher');
    res.sendFile(path.join(__dirname, 'public', 'teacher-login.html'));
});

// Trang ôn tập: danh sách đề do giáo viên công khai, học sinh tự chọn đề.
app.get('/on-tap', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

// Đăng nhập giáo viên bằng mật khẩu (TEACHER_PASSWORD)
app.post('/api/teacher/login', (req, res) => {
    var ip = req.ip || '';
    if (auth.isBlocked(ip)) {
        return res.status(429).json({ success: false, error: 'Quá nhiều lần thử sai. Vui lòng đợi vài phút.' });
    }
    if (!auth.enabled) {
        return res.status(503).json({ success: false, error: 'Server chưa cấu hình TEACHER_PASSWORD.' });
    }
    var password = (req.body && req.body.password) || '';
    if (!auth.checkPassword(password)) {
        auth.recordFailure(ip);
        return res.status(401).json({ success: false, error: 'Mật khẩu không đúng.' });
    }
    auth.clearFailures(ip);
    auth.setCookie(res, auth.issueToken(), isSecureRequest(req));
    res.json({ success: true });
});

// Đăng xuất giáo viên
app.post('/api/teacher/logout', (req, res) => {
    auth.clearCookie(res);
    res.json({ success: true });
});

// Kiểm tra phiên đăng nhập (dùng cho giao diện)
app.get('/api/teacher/session', (req, res) => {
    if (!isTeacher(req)) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true });
});

// ========== ẢNH CHÈN TRỰC TIẾP VÀO CÂU HỎI ==========
// Chỉ giáo viên được tải lên. Nội dung được kiểm tra magic bytes, không tin
// tên file/MIME do trình duyệt khai báo.
app.post('/api/assets', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền' });
    assetUpload.single('file')(req, res, function (err) {
        if (err) {
            var msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'Ảnh quá lớn. Tối đa ' + Math.round(fileValidate.FILE_LIMITS.maxImageBytes / 1024 / 1024) + ' MB.'
                : (err.message || 'Lỗi tải ảnh lên.');
            return res.status(400).json({ error: msg });
        }
        if (!req.file) return res.status(400).json({ error: 'Chưa chọn ảnh.' });

        var check = fileValidate.validateUpload(req.file);
        if (!check.ok) return res.status(400).json({ error: check.error });

        var id = assets.newId(check.imageType);
        if (!id) return res.status(400).json({ error: 'Định dạng ảnh không hỗ trợ.' });

        DATA.saveAsset(id, req.file.buffer).then(function () {
            res.json({ success: true, url: assets.urlForId(id) });
        }).catch(function () {
            res.status(500).json({ error: 'Không lưu được ảnh. Vui lòng thử lại.' });
        });
    });
});

// Ảnh dùng chung cho cả giáo viên và học sinh. Id ngẫu nhiên 128-bit nên
// không đoán được; nội dung đã được xác thực là ảnh ở bước tải lên.
app.get('/api/assets/:id', function (req, res) {
    var id = req.params.id;
    if (!assets.isAssetId(id)) return res.status(404).end();

    DATA.readAsset(id).then(function (buffer) {
        if (!buffer || !buffer.length) return res.status(404).end();
        res.set('Content-Type', assets.mimeForId(id));
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(buffer);
    }).catch(function () {
        res.status(404).end();
    });
});

// Lưu trữ dữ liệu
var questions = [];
var results = [];
var students = []; // Danh sách học sinh từ Excel
var studentStatus = {}; // Trạng thái học sinh: { stt: { selected: false, selectedBy: null, completed: false, canRetry: false } }
var socketToStt = {}; // Map socketId -> stt để O(1) lookup trong disconnect
var reports = []; // Báo cáo chọn nhầm
var serverProgress = {}; // Progress backup: { stt: { startTime, examId, answers, questionOrder, optionOrders, timeLimit, savedAt } }

// ========== HỆ THỐNG QUẢN LÝ LỚP & BÀI KIỂM TRA ==========
// Mỗi lớp có thể làm nhiều bài kiểm tra
// Mỗi bài kiểm tra có thể cho nhiều lớp làm
// Kết quả lưu theo cặp: classId + examId

var currentSession = {
    classId: null,   // ID lớp hiện tại
    className: null, // Tên lớp hiện tại 
    examId: null,    // ID bài kiểm tra hiện tại
    examName: null   // Tên bài kiểm tra hiện tại
};

var classesData = {};  // { classId: { id, name, studentFile, studentCount, createdAt } }

var examSettings = {
    title: 'Bài kiểm tra trắc nghiệm',
    timeLimit: 30,
    isOpen: false,
    showScore: false,
    practiceMode: false,
    // Cấu hình Ôn tập (null = không giới hạn). Mặc định tương thích đề cũ.
    practiceMaxAttempts: null,
    practiceTimeLimitMinutes: null,
    practiceReviewMode: 'answer',
    shuffleExam: false,
    examPassword: '',
    requirePassword: false
};

// ========== QUẢN LÝ LỚP ==========
function loadClasses() {
    classesData = DATA.readJson(path.join(__dirname, 'data', 'classes.json'), {}) || {};
}

function saveClasses() {
    DATA.writeJson(path.join(__dirname, 'data', 'classes.json'), classesData);
}

function getClassList() {
    return Object.entries(classesData).map(([id, data]) => ({
        id,
        name: data.name,
        studentCount: data.studentCount || 0,
        studentFile: data.studentFile || null,
        createdAt: data.createdAt
    })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function createClass(name) {
    var id = 'class_' + Date.now();
    classesData[id] = {
        id,
        name,
        studentCount: 0,
        studentFile: null,
        createdAt: new Date().toISOString()
    };
    saveClasses();
    return classesData[id];
}

function deleteClass(classId) {
    if (classesData[classId]) {
        delete classesData[classId];
        saveClasses();
        return true;
    }
    return false;
}

// ========== QUẢN LÝ BÀI KIỂM TRA ==========
function getSavedExams() {
    var examsDir = path.join(__dirname, 'data', 'exams');
    var files = DATA.listJsonNames(examsDir).filter(function(f) { return f.endsWith('.json'); });
    return files.map(function(f) {
        var data = DATA.readJson(path.join(examsDir, f), null);
        if (!data) return null;
        return {
            id: f.replace('.json', ''),
            name: data.name || f.replace('.json', ''),
            questionCount: data.questions ? data.questions.length : 0,
            createdAt: data.createdAt || null
        };
    }).filter(function(e) { return e !== null; });
}

function saveExam(examId, name) {
    var examData = {
        name: name,
        questions: questions,
        settings: mergeObjects(examSettings, { title: name }),
        createdAt: new Date().toISOString()
    };
    DATA.writeJson(path.join(__dirname, 'data', 'exams', examId + '.json'), examData);
}

function loadExam(examId) {
    return DATA.readJson(path.join(__dirname, 'data', 'exams', examId + '.json'), null);
}

function deleteExam(examId) {
    var examPath = path.join(__dirname, 'data', 'exams', examId + '.json');
    if (DATA.exists(examPath)) {
        DATA.del(examPath);
        return true;
    }
    return false;
}

// ========== DANH SÁCH ÔN TẬP ==========
// Một danh sách chỉ tham chiếu examId; không sao chép câu hỏi/đáp án.
var reviewLists = {};
var REVIEW_LISTS_PATH = path.join(__dirname, 'data', 'review-lists.json');

function isSafeId(id) {
    return /^[A-Za-z0-9_-]+$/.test(String(id || ''));
}

function loadReviewLists() {
    reviewLists = DATA.readJson(REVIEW_LISTS_PATH, {}) || {};
}

function saveReviewLists() {
    DATA.writeJson(REVIEW_LISTS_PATH, reviewLists);
}

function getReviewList(listId) {
    if (!isSafeId(listId)) return null;
    return reviewLists[listId] || null;
}

function getReviewAttemptsPath(listId, examId) {
    return path.join(__dirname, 'data', 'review-attempts', listId + '__' + examId + '.json');
}

function loadReviewAttempts(listId, examId) {
    var data = DATA.readJson(getReviewAttemptsPath(listId, examId), []);
    return Array.isArray(data) ? data : [];
}

function saveReviewAttempts(listId, examId, attempts) {
    DATA.writeJson(getReviewAttemptsPath(listId, examId), attempts);
}

function findReviewItem(list, examId) {
    if (!list || !Array.isArray(list.items)) return null;
    for (var i = 0; i < list.items.length; i++) {
        if (list.items[i] && String(list.items[i].examId) === String(examId)) return list.items[i];
    }
    return null;
}

function findStudentByStt(stt) {
    if (stt === undefined || stt === null) return null;
    for (var i = 0; i < students.length; i++) {
        if (String(students[i].stt) === String(stt)) return students[i];
    }
    return null;
}

function studentFullName(s) {
    return ((s.ho || '') + ' ' + (s.ten || '')).trim();
}

// Danh sách lớp hiện tại để đối chiếu "đã làm / chưa làm" khi xem kết quả.
function reviewRoster() {
    return students.map(function (s) {
        return {
            stt: s.stt,
            name: studentFullName(s),
            className: currentSession.className || ''
        };
    });
}

function publicReviewExam(examId, settings) {
    var exam = loadExam(examId);
    if (!exam) {
        return {
            examId: examId,
            examName: '[Đề đã bị xóa]',
            questionCount: 0,
            available: false,
            settings: settings
        };
    }
    var qs = Array.isArray(exam.questions) ? exam.questions : [];
    return {
        examId: examId,
        examName: exam.name || examId,
        questionCount: qs.length,
        available: true,
        settings: settings
    };
}

function buildReviewListPayload(list, stt) {
    var items = (list.items || []).map(function (item) {
        var info = publicReviewExam(item.examId, item.settings);
        var attempts = loadReviewAttempts(list.id, item.examId);
        info.history = review.statusOf(attempts, item.settings.maxAttempts, stt);
        return info;
    });
    return {
        id: list.id,
        name: list.name,
        description: list.description || '',
        subject: list.subject || '',
        active: list.active !== false,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt,
        itemCount: items.length,
        items: items
    };
}

function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ' phút ' + s + ' giây';
}

function reviewSettingsPayload(settings) {
    return {
        maxAttempts: settings.maxAttempts,
        timeLimit: settings.timeLimit,
        showResult: settings.showResult,
        showAnswers: settings.showAnswers,
        practiceMode: settings.practiceMode,
        shuffleExam: settings.shuffleExam
    };
}

// Ghi kết quả vào một lượt làm. Dùng chung cho nộp bài và đóng lượt quá hạn.
// Không ghi đè lượt khác; caller tự lưu mảng attempts.
function settleReviewAttempt(attempt, questions, answers, settings, expired) {
    var now = Date.now();
    var limit = review.attemptTimeLimit(attempt, settings);
    var elapsedSec = Math.max(0, Math.floor((now - new Date(attempt.startedAt).getTime()) / 1000));
    if (limit > 0) elapsedSec = Math.min(elapsedSec, limit * 60);

    var graded = gradeQuestions(questions, answers, { snapshot: true });
    attempt.status = 'submitted';
    attempt.submittedAt = new Date(now).toISOString();
    attempt.expired = !!expired;
    attempt.score = graded.score;
    attempt.maxScore = graded.maxScore;
    attempt.correctCount = graded.correctCount;
    attempt.partialCount = graded.partialCount;
    attempt.wrongCount = graded.wrongCount;
    attempt.unansweredCount = graded.unansweredCount;
    attempt.totalQuestions = graded.totalQuestions;
    attempt.timeSpent = formatDuration(elapsedSec);
    attempt.details = graded.details;
    return graded;
}

// Ẩn đáp án trước khi học sinh nộp bài.
function sanitizeExamForStudent(questionList) {
    return (questionList || []).map(function (q, index) {
        var mq = migrateQuestion(q);
        return {
            id: index,
            type: mq.type || 'single',
            question: mq.question,
            options: mq.options,
            image: mq.image || null
        };
    });
}

function filterHistoryDetails(settings, details) {
    if (!Array.isArray(details)) return null;
    if (!settings.showResult && !settings.showAnswers) return null;
    return details.map(function (d, position) {
        var hasAnswer = d.hasAnswer !== undefined
            ? !!d.hasAnswer
            : !!(d.studentAnswerText !== undefined && d.studentAnswerText !== null && String(d.studentAnswerText).trim() !== '');
        var item = {
            index: typeof d.index === 'number' ? d.index : position,
            question: d.question,
            type: d.type,
            studentAnswer: d.studentAnswer,
            studentAnswerText: d.studentAnswerText,
            hasAnswer: hasAnswer,
            options: Array.isArray(d.options) ? d.options : null,
            image: d.image || null
        };
        if (settings.showResult || settings.showAnswers) {
            // Đúng / đúng một phần / sai / chưa trả lời. Câu bỏ trống không phải câu sai.
            item.status = d.status || (hasAnswer
                ? (d.isCorrect ? 'correct' : (Number(d.questionScore) > 0 ? 'partial' : 'wrong'))
                : 'unanswered');
        }
        if (settings.showResult) {
            item.isCorrect = d.isCorrect;
            item.questionScore = d.questionScore;
        }
        if (settings.showAnswers) {
            item.correctAnswerText = d.correctAnswerText;
            item.correctAnswer = d.correctAnswer;
            item.correctList = d.correctList;
            item.correctTF = d.correctTF;
        }
        return item;
    });
}

// ========== QUẢN LÝ KẾT QUẢ THEO LỚP + BÀI ==========
function getResultKey(classId, examId) {
    return `${classId}__${examId}`;
}

function loadResultsForSession(classId, examId) {
    var key = getResultKey(classId, examId);
    return DATA.readJson(path.join(__dirname, 'data', 'results', key + '.json'), []) || [];
}

function saveResultsForSession(classId, examId, resultsData) {
    var key = getResultKey(classId, examId);
    DATA.writeJson(path.join(__dirname, 'data', 'results', key + '.json'), resultsData);
}

function getAllResultsSummary() {
    var resultsDir = path.join(__dirname, 'data', 'results');
    var files = DATA.listJsonNames(resultsDir).filter(function(f) { return f.endsWith('.json'); });
    return files.map(function(f) {
        var data = DATA.readJson(path.join(resultsDir, f), null);
        if (!data) return null;
        var parts = f.replace('.json', '').split('__');
        var classId = parts[0];
        var examId = parts[1];
        var classData = classesData[classId];
        var className = (classData && classData.name) ? classData.name : classId;
        var exam = loadExam(examId);
        var examName = (exam && exam.name) ? exam.name : examId;

        return {
            classId: classId,
            className: className,
            examId: examId,
            examName: examName,
            resultCount: data.length,
            avgScore: data.length > 0 ? (data.reduce(function(s, r) { return s + r.score; }, 0) / data.length).toFixed(1) : 0
        };
    }).filter(function(e) { return e !== null; });
}

// Load/Save trạng thái phiên hiện tại
function loadCurrentSession() {
    var data = DATA.readJson(path.join(__dirname, 'data', 'current-session.json'), null);

    if (!data) {
        console.log('    (Chua co file session, dung mac dinh)');
        currentSession = { classId: null, className: null, examId: null, examName: null };
        return;
    }

    if (data.currentSession) {
        currentSession.classId = data.currentSession.classId || null;
        currentSession.className = data.currentSession.className || null;
        currentSession.examId = data.currentSession.examId || null;
        currentSession.examName = data.currentSession.examName || null;
    }

    if (data.examSettings) {
        var keys = Object.keys(data.examSettings);
        for (var i = 0; i < keys.length; i++) {
            examSettings[keys[i]] = data.examSettings[keys[i]];
        }
        // Luôn reset về chế độ thi khi khởi động, không giữ trạng thái ôn tập cũ
        examSettings.practiceMode = false;
        examSettings.isOpen = false;
        examSettings.showScore = false;
        examSettings.shuffleExam = true;
    }
}

function saveCurrentSession() {
    DATA.writeJson(path.join(__dirname, 'data', 'current-session.json'), {
        currentSession: currentSession,
        examSettings: examSettings
    });
}

// Lấy key để lưu kết quả theo lớp + bài
function getSessionResultKey() {
    if (!currentSession.classId || !currentSession.examId) return null;
    return currentSession.classId + '__' + currentSession.examId;
}

// Load kết quả theo lớp + bài hiện tại
function loadSessionResults() {
    var key = getSessionResultKey();
    if (!key) {
        results = [];
        return;
    }
    results = DATA.readJson(path.join(__dirname, 'data', 'results', key + '.json'), []) || [];
}

// Lưu kết quả theo lớp + bài hiện tại
function saveSessionResults() {
    var key = getSessionResultKey();
    if (!key) return;
    DATA.writeJson(path.join(__dirname, 'data', 'results', key + '.json'), results);
}

// Load trạng thái học sinh theo lớp + bài hiện tại
function loadSessionStudentStatus() {
    var key = getSessionResultKey();
    if (!key) {
        studentStatus = {};
        return;
    }
    var loaded = DATA.readJson(path.join(__dirname, 'data', 'student-status', key + '.json'), null);
    if (loaded) {
        studentStatus = loaded;
    } else {
        studentStatus = {};
        // Khởi tạo trạng thái cho học sinh từ danh sách
        students.forEach(function(s) {
            studentStatus[s.stt] = {
                selected: false,
                selectedBy: null,
                completed: false,
                canRetry: false
            };
        });
    }
}

// Lưu trạng thái học sinh theo lớp + bài hiện tại
function saveSessionStudentStatus() {
    var key = getSessionResultKey();
    if (!key) return;
    DATA.writeJson(path.join(__dirname, 'data', 'student-status', key + '.json'), studentStatus);
}

// Load danh sách học sinh theo lớp hiện tại
function loadStudentsForClass() {
    if (!currentSession.classId) {
        // Nếu chưa chọn lớp, load file mặc định
        loadStudentsFromDefaultFile();
        return;
    }

    var classData = classesData[currentSession.classId];
    if (!classData) {
        loadStudentsFromDefaultFile();
        return;
    }

    // Ưu tiên danh sách đã phân tích lưu trong storage
    var studentsKey = path.join(__dirname, 'data', 'class-students', currentSession.classId + '.students.json');
    var parsed = DATA.readJson(studentsKey, null);
    if (Array.isArray(parsed)) {
        students = parsed;
        console.log('[OK] Da tai ' + students.length + ' hoc sinh cho lop ' + currentSession.className);
        return;
    }

    // Migration: đọc file Excel cũ nếu còn trên đĩa (bản LAN)
    if (classData.studentFile) {
        var filePath = path.join(__dirname, 'data', 'class-students', classData.studentFile);
        if (fs.existsSync(filePath)) {
            try {
                var workbook = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
                var sheetName = workbook.SheetNames[0];
                var worksheet = workbook.Sheets[sheetName];
                var rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
                var migrated = parseStudentDataRaw(rawRows);
                if (!migrated) migrated = parseStudentData(XLSX.utils.sheet_to_json(worksheet));
                students = migrated || [];
                DATA.writeJson(studentsKey, students);
                console.log('[OK] Da migrate ' + students.length + ' hoc sinh tu Excel cho lop ' + currentSession.className);
                return;
            } catch (err) {
                console.error('Lỗi đọc file học sinh:', err);
            }
        }
    }

    loadStudentsFromDefaultFile();
}

function loadStudentsFromDefaultFile() {
    var stored = DATA.readJson(path.join(__dirname, 'data', 'default-students.json'), null);
    if (Array.isArray(stored)) {
        students = stored;
        console.log('[OK] Da tai ' + students.length + ' hoc sinh mac dinh');
        return;
    }

    try {
        var excelPath = path.join(__dirname, 'danhsach', 'danhsach.xlsx');
        if (!fs.existsSync(excelPath)) {
            console.log('[!] Chua co file danhsach.xlsx trong thu muc danhsach/');
            students = [];
            return;
        }

        var workbook = XLSX.read(fs.readFileSync(excelPath), { type: 'buffer' });
        var sheetName = workbook.SheetNames[0];
        var worksheet = workbook.Sheets[sheetName];
        var rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        var parsed = parseStudentDataRaw(rawRows);
        if (!parsed) {
            var data = XLSX.utils.sheet_to_json(worksheet);
            parsed = parseStudentData(data);
        }
        students = parsed || [];
        DATA.writeJson(path.join(__dirname, 'data', 'default-students.json'), students);
        console.log('[OK] Da tai ' + students.length + ' hoc sinh tu file mac dinh');
    } catch (err) {
        console.error('Lỗi đọc file Excel:', err);
        students = [];
    }
}

function parseStudentData(data) {
    // Log để debug
    if (data.length > 0) {
        console.log('[INFO] Cac cot trong file Excel:', Object.keys(data[0]));
    }

    var index = 0;
    return data.map(row => {
        index++;

        // Hỗ trợ nhiều tên cột STT khác nhau
        var stt = row['STT'] || row['stt'] || row['Stt'] || row['SỐ TT'] || row['Số TT'] ||
                  row['TT'] || row['tt'] || row['Số thứ tự'] || row['So thu tu'] ||
                  row['#'] || row['No'] || row['NO'] || row['no'] || '';

        // Hỗ trợ nhiều tên cột Họ
        var ho = row['Họ'] || row['Ho'] || row['ho'] || row['HO'] || row['HỌ'] ||
                 row['Họ và tên lót'] || row['Ho va ten lot'] || row['Họ tên lót'] || '';

        // Hỗ trợ nhiều tên cột Tên
        var ten = row['Tên'] || row['Ten'] || row['ten'] || row['TEN'] || row['TÊN'] ||
                  row['Họ và tên'] || row['Ho va ten'] || row['Họ tên'] || row['Ho ten'] ||
                  row['HỌ VÀ TÊN'] || row['HO VA TEN'] || row['Hovaten'] || row['hovaten'] ||
                  row['FullName'] || row['fullname'] || row['FULLNAME'] || row['Name'] || row['name'] || '';

        // Nữ / Giới tính
        var nu = row['Nữ'] || row['Nu'] || row['nu'] || row['NU'] || row['NỮ'] ||
                 row['Giới tính'] || row['GioiTinh'] || row['GIOITINH'] || row['Gioi tinh'] ||
                 row['GT'] || row['gt'] || row['Gender'] || row['gender'] || '';

        // Nếu không có cột HO riêng, lấy tên đầy đủ từ cột TEN
        if (!ho && ten) {
            var parts = ten.trim().split(/\s+/);
            if (parts.length > 1) {
                ten = parts.pop();
                ho = parts.join(' ');
            }
        }

        // Xử lý giới tính
        if (typeof nu === 'string') {
            nu = ['x', 'nữ', 'nu', 'female', 'f', 'n'].includes(nu.toLowerCase()) ? 'X' : '';
        }

        // Nếu không có STT nhưng có tên, tự tạo STT
        if (!stt && (ho || ten)) {
            stt = index;
        }

        // Chuyển STT về string
        stt = String(stt).trim();

        return { stt, ho, ten, nu };
    }).filter(s => s.stt && (s.ho || s.ten)); // Cần có STT và ít nhất họ hoặc tên
}

// Parse từ raw rows (header:1) — hỗ trợ nhiều mẫu file danh sách lớp:
//   Mẫu 1: STT | Họ | Tên                          (tách riêng)
//   Mẫu 2: STT | Họ | Tên | Giới tính
//   Mẫu 3: STT | Họ và tên                          (gộp họ tên)
//   Mẫu 4: STT | Họ và tên | Giới tính
//   Mẫu 5: STT | Họ | Tên lót | Tên                 (3 cột tên)
//   Và file bảng điểm trường (nhiều dòng tiêu đề phía trên)
function parseStudentDataRaw(rows) {
    var headerRow = -1;
    var colSTT = -1, colHoVaTen = -1, colHo = -1, colTenLot = -1, colTen = -1, colGioiTinh = -1;

    // Các từ khoá nhận diện từng loại cột (lowercase, đã bỏ dấu tương đương)
    var sttKeys     = ['stt', 'tt', 'số tt', 'so tt', 'số thứ tự', 'so thu tu', 'tт', '#', 'no.', 'no'];
    var hoVaTenKeys = ['họ và tên', 'ho va ten', 'họ tên', 'ho ten', 'họ & tên', 'ho & ten',
                       'fullname', 'full name', 'name', 'họvàtên', 'họtên'];
    var hoKeys      = ['họ', 'ho', 'họ và tên lót', 'ho va ten lot', 'họ tên lót', 'ho ten lot',
                       'họ, tên lót', 'last name', 'surname'];
    var tenLotKeys  = ['tên lót', 'ten lot', 'tên đệm', 'ten dem', 'middle name'];
    var tenKeys     = ['tên', 'ten', 'first name', 'given name'];
    var gtKeys      = ['giới tính', 'gioi tinh', 'gt', 'gender', 'phái', 'phai', 'nữ', 'nu', 'sex'];

    for (var r = 0; r < Math.min(rows.length, 15); r++) {
        var row = rows[r];
        // Reset mỗi lần thử dòng mới
        var fSTT = -1, fHoVaTen = -1, fHo = -1, fTenLot = -1, fTen = -1, fGT = -1;
        var found = false;

        for (var c = 0; c < row.length; c++) {
            var cell = String(row[c] || '').trim().toLowerCase()
                // bỏ khoảng trắng thừa giữa các từ
                .replace(/\s+/g, ' ');
            if (sttKeys.indexOf(cell) !== -1)     { fSTT = c;     found = true; }
            // Ưu tiên "họ và tên" trước "họ" để tránh nhầm
            else if (hoVaTenKeys.indexOf(cell) !== -1) { fHoVaTen = c; found = true; }
            else if (tenLotKeys.indexOf(cell) !== -1)  { fTenLot = c;  found = true; }
            else if (hoKeys.indexOf(cell) !== -1)      { fHo = c;      found = true; }
            else if (tenKeys.indexOf(cell) !== -1)     { fTen = c;     found = true; }
            if (gtKeys.indexOf(cell) !== -1)      { fGT = c; }
        }

        // Dòng hợp lệ: phải có STT hoặc ít nhất 1 cột tên
        var hasName = fHoVaTen !== -1 || fHo !== -1 || fTen !== -1;
        if (found && (fSTT !== -1 || hasName)) {
            headerRow    = r;
            colSTT       = fSTT;
            colHoVaTen   = fHoVaTen;
            colHo        = fHo;
            colTenLot    = fTenLot;
            colTen       = fTen;
            colGioiTinh  = fGT;
            break;
        }
    }

    if (headerRow === -1) return null;

    var result = [];
    for (var i = headerRow + 1; i < rows.length; i++) {
        var row = rows[i];

        var rawSTT = colSTT !== -1 ? row[colSTT] : '';
        var sttNum = parseInt(rawSTT, 10);
        if (isNaN(sttNum)) continue; // sub-header hoặc dòng tổng kết

        // Đọc các cột tên
        var hoVaTen = colHoVaTen !== -1 ? String(row[colHoVaTen] || '').trim() : '';
        var ho      = colHo      !== -1 ? String(row[colHo]      || '').trim() : '';
        var tenLot  = colTenLot  !== -1 ? String(row[colTenLot]  || '').trim() : '';
        var ten     = colTen     !== -1 ? String(row[colTen]     || '').trim() : '';
        var rawGT   = colGioiTinh !== -1 ? String(row[colGioiTinh] || '').trim() : '';

        // Bỏ dòng hoàn toàn trống
        if (!hoVaTen && !ho && !ten) continue;

        // Mẫu "Họ và tên" gộp: tách lấy tên (từ cuối) và họ (phần còn lại)
        if (hoVaTen && !ho && !ten) {
            var parts = hoVaTen.split(/\s+/);
            ten = parts.pop() || '';
            ho  = parts.join(' ');
        }

        // Mẫu "Họ | Tên lót | Tên": ghép tên lót vào họ
        if (tenLot && ho) {
            ho = ho + ' ' + tenLot;
        } else if (tenLot && !ho) {
            ho = tenLot;
        }

        // Nếu vẫn thiếu họ nhưng có tên đủ → tách
        if (!ho && ten && ten.indexOf(' ') !== -1) {
            var parts2 = ten.split(/\s+/);
            ten = parts2.pop() || '';
            ho  = parts2.join(' ');
        }

        // Giới tính: nhận dạng nữ theo nhiều cách
        var nu = '';
        if (rawGT) {
            var gtLower = rawGT.toLowerCase();
            if (['x', 'nữ', 'nu', 'female', 'f', 'n', '1'].indexOf(gtLower) !== -1) {
                nu = 'X';
            }
            // "Nam"/"M"/"0" → để trống (mặc định nam)
        }

        if (ho || ten) {
            result.push({ stt: String(sttNum), ho: ho, ten: ten, nu: nu });
        }
    }
    return result.length > 0 ? result : null;
}

// Migrate câu hỏi cũ sang định dạng mới (thêm type, strip tags thừa)
function migrateQuestion(q) {
    if (!q) return q;
    var question = q.question || '';

    // Detect type từ tags trong question text
    var type = q.type;
    if (!type) {
        if (/\[MULTI\]/i.test(question)) {
            type = 'multi';
        } else if (/\[TRẢ LỜI NGẮN\]|\[TRA LOI NGAN\]|\[SHORT\]/i.test(question)) {
            type = 'shortanswer';
        } else if (/\[ĐÚNG\/SAI\]|\[DUNGSAI\]|\[DUNG\/SAI\]/i.test(question)) {
            type = 'truefalse';
        } else {
            type = 'single';
        }
    }

    // Strip type tags khỏi question text
    question = question
        .replace(/\[MULTI\]/gi, '')
        .replace(/\[TRẢ LỜI NGẮN\]/gi, '')
        .replace(/\[TRA LOI NGAN\]/gi, '')
        .replace(/\[SHORT\]/gi, '')
        .replace(/\[ĐÚNG\/SAI\]/gi, '')
        .replace(/\[DUNGSAI\]/gi, '')
        .replace(/\[DUNG\/SAI\]/gi, '')
        .trim();

    var TF_TRUE_RE = /\(đúng\)|\(dung\)|\(Đ\)|\(đ\)|\(D\)|\(d\)|\(T\)|\(t\)|\(Y\)|\(y\)/i;
    var TF_FALSE_RE = /\(sai\)|\(S\)|\(s\)|\(F\)|\(f\)|\(N\)|\(n\)/i;
    var TF_ALL_RE   = /\(đúng\)|\(dung\)|\(Đ\)|\(đ\)|\(D\)|\(d\)|\(T\)|\(t\)|\(Y\)|\(y\)|\(sai\)|\(S\)|\(s\)|\(F\)|\(f\)|\(N\)|\(n\)/gi;
    var CORRECT_RE  = /\s*\*\s*$/;

    var options = Array.isArray(q.options) ? q.options.slice() : [];
    var correct = typeof q.correct === 'number' ? q.correct : 0;
    var correctList = Array.isArray(q.correctList) ? q.correctList : null;
    var correctTF = Array.isArray(q.correctTF) ? q.correctTF : null;

    if (type === 'truefalse' && !correctTF) {
        // Build correctTF từ markers trong options
        correctTF = options.map(function(opt) {
            return TF_TRUE_RE.test(opt);
        });
        // Strip markers khỏi options
        options = options.map(function(opt) {
            return opt.replace(TF_ALL_RE, '').trim();
        });
    }

    if (type === 'multi' && !correctList) {
        // Build correctList từ dấu * trong options
        correctList = [];
        options = options.map(function(opt, i) {
            if (CORRECT_RE.test(opt)) {
                correctList.push(i);
                return opt.replace(CORRECT_RE, '').trim();
            }
            return opt;
        });
        if (correctList.length === 0) correctList = [correct];
    }

    return {
        type: type,
        question: question,
        options: type === 'shortanswer' ? [] : options,
        correct: correct,
        correctList: type === 'multi' ? correctList : null,
        correctTF: type === 'truefalse' ? correctTF : null,
        correctAnswer: type === 'shortanswer' ? shortAnswer.normalize(q.correctAnswer) : null,
        image: q.image || null,
        points: normalizePoints(q.points)
    };
}

// Áp cấu hình đã lưu của một đề vào phiên hiện tại.
// Giữ hành vi cũ: mỗi lần chọn/chuyển đề đều tắt Ôn tập, tắt hiển thị điểm,
// bật trộn đề và đóng bài thi; riêng cấu hình Ôn tập (số lượt/thời gian/cách
// xem kết quả) được nạp lại từ đề đã lưu.
function applyExamSettings(settings) {
    examSettings.practiceMaxAttempts = null;
    examSettings.practiceTimeLimitMinutes = null;
    examSettings.practiceReviewMode = 'answer';
    examSettings = mergeObjects(examSettings, settings || {});
    var cfg = practice.normalizeConfig(examSettings);
    examSettings.practiceMaxAttempts = cfg.maxAttempts;
    examSettings.practiceTimeLimitMinutes = cfg.timeLimitMinutes;
    examSettings.practiceReviewMode = cfg.reviewMode;
    examSettings.practiceMode = false;
    examSettings.showScore = false;
    examSettings.shuffleExam = true;
    examSettings.isOpen = false;
}

// Load câu hỏi từ file hoặc từ bài kiểm tra hiện tại
function loadQuestions() {
    // Nếu đang có session với examId, load từ exam đã lưu
    if (currentSession.examId) {
        var exam = loadExam(currentSession.examId);
        if (exam) {
            questions = (exam.questions || []).map(migrateQuestion);
            applyExamSettings(exam.settings);
            console.log('[OK] Da tai ' + questions.length + ' cau hoi tu bai "' + currentSession.examName + '"');
            return;
        }
    }
    
    // Load từ file mặc định
    var defaultQuestions = DATA.readJson(path.join(__dirname, 'data', 'questions.json'), null);
    if (Array.isArray(defaultQuestions)) {
        questions = defaultQuestions.map(migrateQuestion);
        console.log('[OK] Da tai ' + questions.length + ' cau hoi');
    } else {
        questions = [];
        console.log('[!] Chua co file cau hoi, se tao moi khi them cau hoi');
    }
}

// Debounce helper: gom nhiều lần gọi trong window ms thành 1 lần ghi đĩa
function makeDebouncedSaver(fn, delay) {
    var timer = null;
    return function() {
        clearTimeout(timer);
        timer = setTimeout(fn, delay);
    };
}

// Ghi dữ liệu: DATA (datastore) cập nhật cache ngay và ghi nền (queued, atomic).

// Lưu câu hỏi vào file
function saveQuestions() {
    DATA.writeJson(path.join(__dirname, 'data', 'questions.json'), questions);
    // Nếu đang có exam, cập nhật exam đó
    if (currentSession.examId && currentSession.examName) {
        saveExam(currentSession.examId, currentSession.examName);
    }
}

// Lưu kết quả vào file - ƯU TIÊN lưu theo session
function saveResults() {
    var key = getSessionResultKey();
    if (key) {
        DATA.writeJson(path.join(__dirname, 'data', 'results', key + '.json'), results);
    } else {
        DATA.writeJson(path.join(__dirname, 'data', 'results.json'), results);
    }
}

// Load kết quả
function loadResults() {
    var key = getSessionResultKey();
    if (key) {
        results = DATA.readJson(path.join(__dirname, 'data', 'results', key + '.json'), []) || [];
    } else {
        results = DATA.readJson(path.join(__dirname, 'data', 'results.json'), []) || [];
    }
}

// ========== ÔN TẬP: LƯU LỊCH SỬ TỪNG LƯỢT ==========
// Mỗi cặp (đề, học sinh) là một document chứa mảng attempts. Không ghi đè lượt cũ.
function getCurrentExamId() {
    return currentSession.examId || 'default';
}

function practiceDocPath(examId, stt) {
    var safeExam = String(examId).replace(/[^A-Za-z0-9_-]/g, '_');
    var safeStt = String(stt).replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(__dirname, 'data', 'practice', safeExam + '__' + safeStt + '.json');
}

function loadPracticeDoc(examId, stt) {
    return DATA.readJson(practiceDocPath(examId, stt), null);
}

function savePracticeDoc(examId, stt, doc) {
    DATA.writeJson(practiceDocPath(examId, stt), doc);
}

function isValidStudentStt(stt) {
    if (stt === undefined || stt === null || stt === '') return false;
    return students.some(function(s) { return String(s.stt) === String(stt); });
}

// Lưu cấu hình phiên hiện tại vào file đề để giữ qua các lần chọn đề.
function persistCurrentExamSettings() {
    if (!currentSession.examId) return;
    var examPath = path.join(__dirname, 'data', 'exams', currentSession.examId + '.json');
    var examData = DATA.readJson(examPath, null);
    if (!examData) return;
    examData.settings = mergeObjects(examData.settings || {}, examSettings);
    DATA.writeJson(examPath, examData);
}

// Snapshot câu hỏi tại thời điểm bắt đầu lượt: xem lại không sai nếu giáo viên sửa đề.
function currentExamSnapshot() {
    return {
        name: currentSession.examName || examSettings.title,
        at: new Date().toISOString(),
        questions: JSON.parse(JSON.stringify(questions.map(migrateQuestion)))
    };
}

// ========== CHỌN TÊN HỌC SINH ==========
// Đã bỏ tính năng mã PIN học sinh.
// Học sinh chỉ chọn tên của mình trong danh sách; server chặn 2 người cùng chọn
// 1 tên (xem /api/select-student, /api/deselect-student).

// Load danh sách học sinh từ lớp hiện tại hoặc file mặc định
function loadStudents() {
    loadStudentsForClass();
    
    // Khởi tạo trạng thái cho học sinh nếu chưa có
    students.forEach(s => {
        if (!studentStatus[s.stt]) {
            studentStatus[s.stt] = {
                selected: false,
                selectedBy: null,
                completed: false,
                canRetry: false
            };
        }
    });
}

// Lưu trạng thái học sinh - ƯU TIÊN lưu theo session
function saveStudentStatus() {
    var key = getSessionResultKey();
    if (key) {
        DATA.writeJson(path.join(__dirname, 'data', 'student-status', key + '.json'), studentStatus);
    } else {
        DATA.writeJson(path.join(__dirname, 'data', 'student-status.json'), studentStatus);
    }
}

// Load trạng thái học sinh
function loadStudentStatus() {
    var key = getSessionResultKey();
    if (key) {
        studentStatus = DATA.readJson(path.join(__dirname, 'data', 'student-status', key + '.json'), {}) || {};
    } else {
        studentStatus = DATA.readJson(path.join(__dirname, 'data', 'student-status.json'), {}) || {};
    }
}

// Debounce saveStudentStatus cho tabLeave/fullscreenExit (gọi liên tục khi học sinh chuyển tab)
var _saveStudentStatusDebounced = makeDebouncedSaver(function() {
    saveStudentStatus();
}, 1500);

// Lưu server progress (backup bài làm dở) — debounce 2s vì gọi rất thường xuyên
var _saveProgressDebounced = makeDebouncedSaver(function() {
    DATA.writeJson(path.join(__dirname, 'data', 'progress', 'server-progress.json'), serverProgress);
}, 2000);
function saveServerProgress() {
    _saveProgressDebounced();
}

// Load server progress (và dọn dẹp các entry cũ hơn 24 giờ)
function loadServerProgress() {
    serverProgress = DATA.readJson(path.join(__dirname, 'data', 'progress', 'server-progress.json'), {}) || {};
    // TTL cleanup: xóa progress cũ hơn 24 giờ để tránh tích tụ
    var cutoff = Date.now() - 24 * 60 * 60 * 1000;
    var keys = Object.keys(serverProgress);
    var cleaned = 0;
    for (var i = 0; i < keys.length; i++) {
        var entry = serverProgress[keys[i]];
        if (entry && entry.savedAt && new Date(entry.savedAt).getTime() < cutoff) {
            delete serverProgress[keys[i]];
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log('[INFO] TTL cleanup: da xoa ' + cleaned + ' progress cu');
        saveServerProgress();
    }
}

// Lưu báo cáo
function saveReports() {
    DATA.writeJson(path.join(__dirname, 'data', 'reports.json'), reports);
}

// Load báo cáo
function loadReports() {
    reports = DATA.readJson(path.join(__dirname, 'data', 'reports.json'), []) || [];
}

// API Routes

// API ping để test kết nối - endpoint đơn giản nhất
app.get('/api/ping', (req, res) => {
    res.json({ 
        ok: true, 
        serverTime: new Date().toISOString(),
        message: 'Server hoạt động bình thường'
    });
});

// Lấy danh sách học sinh với trạng thái
app.get('/api/students', (req, res) => {
    var studentsWithStatus = students.map(function(s) {
        return mergeObjects(s, {
            fullName: (s.ho || '') + ' ' + (s.ten || ''),
            status: studentStatus[s.stt] || { selected: false, selectedBy: null, completed: false, canRetry: false }
        });
    });
    res.json(studentsWithStatus);
});

// Học sinh chọn tên
app.post('/api/select-student', (req, res) => {
    var { stt, socketId } = req.body;

    // Kiểm tra học sinh có trong danh sách không
    var student = students.find(s => s.stt == stt);
    if (!student) {
        return res.json({ success: false, error: 'Không tìm thấy học sinh' });
    }

    // Tạo status nếu chưa có
    if (!studentStatus[stt]) {
        studentStatus[stt] = { selected: false, selectedBy: null, completed: false, canRetry: false };
    }
    
    var status = studentStatus[stt];
    
    // Kiểm tra đã hoàn thành chưa
    if (status.completed && !status.canRetry) {
        return res.json({ success: false, error: 'Học sinh này đã hoàn thành bài thi' });
    }
    
    // Kiểm tra đã được chọn chưa
    if (status.selected && status.selectedBy !== socketId) {
        return res.json({ success: false, error: 'Tên này đã được chọn bởi người khác' });
    }
    
    // Đánh dấu đã chọn
    status.selected = true;
    status.selectedBy = socketId;
    socketToStt[socketId] = stt; // map để O(1) lookup khi disconnect
    if (status.canRetry) {
        status.canRetry = false; // Reset retry flag
    }
    saveStudentStatus();
    
    // Thông báo cho tất cả client
    io.emit('studentStatusUpdated', { stt, status: studentStatus[stt] });
    
    res.json({ success: true, student });
});

// Hủy chọn học sinh (khi đóng trang hoặc muốn đổi)
app.post('/api/deselect-student', (req, res) => {
    var { stt, socketId } = req.body;
    
    // Kiểm tra học sinh có trong danh sách không
    var student = students.find(s => s.stt == stt);
    if (!student) {
        return res.json({ success: false, error: 'Không tìm thấy học sinh' });
    }
    
    // Nếu chưa có status thì không cần làm gì
    if (!studentStatus[stt]) {
        return res.json({ success: true });
    }
    
    var status = studentStatus[stt];
    
    // Chỉ hủy nếu đúng người đã chọn và chưa hoàn thành
    if (status.selectedBy === socketId && !status.completed) {
        status.selected = false;
        status.selectedBy = null;
        delete socketToStt[socketId];
        saveStudentStatus();

        io.emit('studentStatusUpdated', { stt, status: studentStatus[stt] });
    }
    
    res.json({ success: true });
});

// Báo cáo chọn nhầm
app.post('/api/report-wrong-selection', (req, res) => {
    var { wrongSTT, correctSTT, reason, socketId } = req.body;
    
    var wrongStudent = students.find(s => s.stt == wrongSTT);
    var correctStudent = students.find(s => s.stt == correctSTT);
    
    if (!wrongStudent || !correctStudent) {
        return res.json({ success: false, error: 'Không tìm thấy thông tin học sinh' });
    }
    
    var report = {
        id: Date.now(),
        wrongSTT,
        wrongName: `${wrongStudent.ho} ${wrongStudent.ten}`,
        correctSTT,
        correctName: `${correctStudent.ho} ${correctStudent.ten}`,
        reason: reason || 'Chọn nhầm',
        socketId,
        status: 'pending', // pending, approved, rejected
        createdAt: new Date().toLocaleString('vi-VN')
    };
    
    reports.push(report);
    saveReports();
    
    // Thông báo cho giáo viên
    io.emit('newReport', report);
    
    res.json({ success: true, report });
});

// Lấy danh sách báo cáo
app.get('/api/reports', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    res.json(reports.filter(r => r.status === 'pending'));
});

// Duyệt báo cáo chọn nhầm
app.post('/api/approve-report', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện thao tác này' });
    }
    var { reportId } = req.body;
    
    var report = reports.find(r => r.id == reportId);
    if (!report) {
        return res.json({ success: false, error: 'Không tìm thấy báo cáo' });
    }
    
    // Reset học sinh đã chọn nhầm
    if (studentStatus[report.wrongSTT]) {
        studentStatus[report.wrongSTT].selected = false;
        studentStatus[report.wrongSTT].selectedBy = null;
        // Nếu đã hoàn thành, reset để có thể được chọn lại
        if (studentStatus[report.wrongSTT].completed) {
            studentStatus[report.wrongSTT].completed = false;
        }
    }
    
    // Đánh dấu học sinh đúng
    if (studentStatus[report.correctSTT]) {
        studentStatus[report.correctSTT].selected = true;
        studentStatus[report.correctSTT].selectedBy = report.socketId;
    }
    
    // Chuyển kết quả từ tên sai sang tên đúng (nếu đã nộp bài)
    var wrongStudent = students.find(s => s.stt == report.wrongSTT);
    var correctStudent = students.find(s => s.stt == report.correctSTT);
    
    results.forEach(r => {
        if (r.studentSTT == report.wrongSTT && wrongStudent && correctStudent) {
            r.studentSTT = report.correctSTT;
            r.studentName = `${correctStudent.ho} ${correctStudent.ten}`;
            r.note = `(Chuyển từ ${report.wrongName})`;
        }
    });
    
    // Cập nhật trạng thái completed cho tên đúng nếu đã có kết quả
    var hasResult = results.some(r => r.studentSTT == report.correctSTT);
    if (hasResult && studentStatus[report.correctSTT]) {
        studentStatus[report.correctSTT].completed = true;
        studentStatus[report.correctSTT].selected = false;
        studentStatus[report.correctSTT].selectedBy = null;
    }
    
    report.status = 'approved';
    saveStudentStatus();
    saveReports();
    saveResults();
    
    // Thông báo cập nhật
    io.emit('reportProcessed', { reportId, status: 'approved', correctSTT: report.correctSTT });
    io.emit('studentStatusUpdated', { stt: report.wrongSTT, status: studentStatus[report.wrongSTT] });
    io.emit('studentStatusUpdated', { stt: report.correctSTT, status: studentStatus[report.correctSTT] });
    
    res.json({ success: true });
});

// Từ chối báo cáo
app.post('/api/reject-report', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện thao tác này' });
    }
    var { reportId } = req.body;
    
    var report = reports.find(r => r.id == reportId);
    if (!report) {
        return res.json({ success: false, error: 'Không tìm thấy báo cáo' });
    }
    
    report.status = 'rejected';
    saveReports();
    
    io.emit('reportProcessed', { reportId, status: 'rejected' });
    
    res.json({ success: true });
});

// Cho phép học sinh làm lại
app.post('/api/allow-retry', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện thao tác này' });
    }
    var { stt } = req.body;
    
    if (!studentStatus[stt]) {
        return res.json({ success: false, error: 'Không tìm thấy học sinh' });
    }
    
    studentStatus[stt].completed = false;
    studentStatus[stt].selected = false;
    studentStatus[stt].selectedBy = null;
    studentStatus[stt].canRetry = true;
    saveStudentStatus();
    
    io.emit('studentStatusUpdated', { stt, status: studentStatus[stt] });
    io.emit('retryAllowed', { stt });
    
    res.json({ success: true });
});

// Reset tất cả trạng thái học sinh
app.post('/api/reset-all-students', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện thao tác này' });
    }
    students.forEach(s => {
        studentStatus[s.stt] = {
            selected: false,
            selectedBy: null,
            completed: false,
            canRetry: false
        };
    });
    saveStudentStatus();
    
    io.emit('allStudentsReset');
    
    res.json({ success: true });
});

// Lấy danh sách câu hỏi (chỉ cho giáo viên - localhost)
app.get('/api/questions', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    res.json(questions);
});

// Lấy câu hỏi cho học sinh (không có đáp án)
app.get('/api/exam', (req, res) => {
    if (!examSettings.isOpen) {
        return res.json({ error: 'Bài thi chưa được mở' });
    }
    var examQuestions = questions.map((q, index) => {
        var mq = migrateQuestion(q);
        return {
            id: index,
            type: mq.type || 'single',
            question: mq.question,
            options: mq.options,
            image: mq.image || null
        };
    });
    res.json({
        title: examSettings.title,
        timeLimit: examSettings.timeLimit,
        questions: examQuestions,
        className: currentSession.className || 'Chưa chọn lớp',
        examId: currentSession.examId || 'default',
        examName: currentSession.examName || examSettings.title,
        practiceMode: examSettings.practiceMode || false,
        practiceMaxAttempts: examSettings.practiceMaxAttempts === undefined ? null : examSettings.practiceMaxAttempts,
        practiceTimeLimitMinutes: examSettings.practiceTimeLimitMinutes === undefined ? null : examSettings.practiceTimeLimitMinutes,
        practiceReviewMode: examSettings.practiceReviewMode || 'answer',
        shuffleExam: examSettings.shuffleExam !== false
    });
});

// API kiểm tra đáp án trong chế độ ôn tập.
// Chỉ trả đáp án khi giáo viên cho phép VÀ lượt làm đã nộp (không lộ đáp án
// trước khi nộp). Giao diện hiện tại dùng /api/practice/review thay thế.
app.post('/api/check-answer', (req, res) => {
    var cfg = practice.normalizeConfig(examSettings);
    if (!examSettings.practiceMode || cfg.reviewMode !== 'answer') {
        return res.status(403).json({ error: 'Chế độ xem đáp án chưa được bật' });
    }

    var { questionIndex, answer, attemptId, token } = req.body;
    var doc = loadPracticeDoc(getCurrentExamId(), String(req.body.stt || ''));
    var attempt = doc ? practice.findById(doc.attempts, attemptId) : null;
    if (!attempt || attempt.status === 'in_progress' || doc.ownerToken !== token) {
        return res.status(403).json({ error: 'Chưa thể xem đáp án' });
    }

    if (questionIndex < 0 || questionIndex >= questions.length) {
        return res.json({ error: 'Câu hỏi không hợp lệ' });
    }

    var q = migrateQuestion(questions[questionIndex]);
    var questionScore = grading.scoreQuestion(q, answer);

    res.json({
        isCorrect: questionScore === 1,
        questionScore: questionScore,
        type: q.type || 'single',
        correctAnswer: q.correct,
        correctAnswerText: (q.type === 'shortanswer') ? (q.correctAnswer || null) : null,
        correctList: q.correctList || null,
        correctTF: q.correctTF || null,
        yourAnswer: answer
    });
});

// Kiểm tra học sinh đã nộp bài chưa (cho bài thi hiện tại)
app.get('/api/check-submitted/:stt', (req, res) => {
    var stt = req.params.stt;
    var examId = currentSession.examId || 'default';

    // Kiểm tra trong studentStatus
    var status = studentStatus[stt];
    var hasSubmitted = status && status.completed === true;

    res.json({
        submitted: hasSubmitted,
        examId: examId,
        canRetry: status ? status.canRetry : false
    });
});

// Bắt đầu làm bài - lưu startTime lên server
app.post('/api/start-exam', (req, res) => {
    var stt = String(req.body.stt);
    var examId = req.body.examId;
    var timeLimit = req.body.timeLimit || 30;

    // Nếu đã có progress và cùng examId → giữ startTime cũ (restore sau restart)
    if (serverProgress[stt] && serverProgress[stt].examId === examId) {
        return res.json({ success: true, startTime: serverProgress[stt].startTime, serverNow: Date.now(), restored: true });
    }

    serverProgress[stt] = {
        startTime: Date.now(),
        examId: examId,
        timeLimit: timeLimit,
        answers: {},
        questionOrder: [],
        optionOrders: [],
        savedAt: new Date().toISOString()
    };
    saveServerProgress();
    res.json({ success: true, startTime: serverProgress[stt].startTime, serverNow: Date.now(), restored: false });
});

// Sync answers lên server (gọi mỗi 30s)
app.post('/api/save-progress', (req, res) => {
    var stt = String(req.body.stt);
    var examId = req.body.examId;
    var answers = req.body.answers;
    var questionOrder = req.body.questionOrder;
    var optionOrders = req.body.optionOrders;

    if (!serverProgress[stt] || serverProgress[stt].examId !== examId) {
        return res.json({ success: false, error: 'Không tìm thấy session' });
    }

    serverProgress[stt].answers = answers;
    serverProgress[stt].questionOrder = questionOrder;
    serverProgress[stt].optionOrders = optionOrders;
    serverProgress[stt].savedAt = new Date().toISOString();
    saveServerProgress();
    res.json({ success: true });
});

// Lấy progress từ server (dùng khi restore sau Deep Freeze)
app.get('/api/get-progress/:stt', (req, res) => {
    var stt = String(req.params.stt);
    var examId = currentSession.examId || 'default';

    var progress = serverProgress[stt];
    if (!progress || progress.examId !== examId) {
        return res.json({ found: false });
    }

    // Tính timeRemaining từ startTime thực tế
    var elapsed = Math.floor((Date.now() - progress.startTime) / 1000);
    var timeRemaining = Math.max(0, progress.timeLimit * 60 - elapsed);

    res.json({
        found: true,
        startTime: progress.startTime,
        timeRemaining: timeRemaining,
        timeLimit: progress.timeLimit,
        answers: progress.answers,
        questionOrder: progress.questionOrder,
        optionOrders: progress.optionOrders,
        savedAt: progress.savedAt
    });
});

// Thêm câu hỏi mới (chỉ localhost)
app.post('/api/questions', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    var errors = [];
    var normalized = validateAndNormalizeQuestion(req.body, questions.length + 1, errors);
    if (!normalized) {
        return res.status(400).json({ error: errors.join('; ') });
    }
    normalized.question = sanitizeHtml(normalized.question);
    normalized.options = normalized.options.map(function(o) { return sanitizeHtml(o); });
    questions.push(normalized);
    saveQuestions();
    io.emit('questionsUpdated', questions.length);
    res.json({ success: true, total: questions.length });
});

// Sửa câu hỏi (chỉ localhost)
app.put('/api/questions/:id', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    var id = parseInt(req.params.id);
    if (id >= 0 && id < questions.length) {
        var errors = [];
        var normalized = validateAndNormalizeQuestion(req.body, id + 1, errors);
        if (!normalized) {
            return res.status(400).json({ error: errors.join('; ') });
        }
        // Sanitize HTML fields
        normalized.question = sanitizeHtml(normalized.question);
        normalized.options = normalized.options.map(function(o) { return sanitizeHtml(o); });
        questions[id] = normalized;
        saveQuestions();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Không tìm thấy câu hỏi' });
    }
});

// Chỉ đổi điểm của một câu — không ghi đè nội dung/đáp án/ảnh.
app.patch('/api/questions/:id/points', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    var id = parseInt(req.params.id);
    if (!(id >= 0 && id < questions.length)) {
        return res.status(404).json({ error: 'Không tìm thấy câu hỏi' });
    }
    var points = parsePointsInput(req.body && req.body.points);
    if (points === null) {
        return res.status(400).json({ error: 'Điểm phải là số lớn hơn 0 và không quá 100' });
    }
    questions[id].points = points;
    saveQuestions();
    res.json({ success: true, points: points });
});

// Xóa câu hỏi (chỉ localhost)
app.delete('/api/questions/:id', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    var id = parseInt(req.params.id);
    if (id >= 0 && id < questions.length) {
        questions.splice(id, 1);
        saveQuestions();
        io.emit('questionsUpdated', questions.length);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Không tìm thấy câu hỏi' });
    }
});

// Cài đặt bài thi
app.get('/api/settings', (req, res) => {
    var payload = mergeObjects(examSettings, {
        currentSession: currentSession,
        currentExamId: currentSession.examId, // backward compatible
        serverTime: new Date().toISOString() // Thời gian server để client đồng bộ
    });
    // Không để lộ mật khẩu phòng thi cho học sinh / người lạ
    if (!isTeacher(req)) {
        payload.examPassword = '';
    }
    res.json(payload);
});

app.post('/api/settings', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện thao tác này' });
    }
    var configError = practice.validateConfig(req.body);
    if (configError) {
        return res.status(400).json({ success: false, error: configError });
    }
    examSettings = mergeObjects(examSettings, req.body);
    var cfg = practice.normalizeConfig(examSettings);
    examSettings.practiceMaxAttempts = cfg.maxAttempts;
    examSettings.practiceTimeLimitMinutes = cfg.timeLimitMinutes;
    examSettings.practiceReviewMode = cfg.reviewMode;
    saveCurrentSession();
    persistCurrentExamSettings();
    io.emit('examStatusChanged', examSettings.isOpen);
    io.emit('settingsChanged', {
        practiceMode: examSettings.practiceMode,
        practiceMaxAttempts: examSettings.practiceMaxAttempts,
        practiceTimeLimitMinutes: examSettings.practiceTimeLimitMinutes,
        practiceReviewMode: examSettings.practiceReviewMode
    });
    res.json({ success: true });
});

// Mở bài thi
app.post('/api/exam/open', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    if (questions.length === 0) {
        return res.json({ success: false, error: 'Chưa có câu hỏi nào trong bài thi' });
    }
    
    examSettings.isOpen = true;
    saveCurrentSession();
    io.emit('examStatusChanged', true);
    io.emit('examOpened');
    res.json({ success: true, message: 'Bài thi đã mở' });
});

// Đóng bài thi
app.post('/api/exam/close', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    examSettings.isOpen = false;
    saveCurrentSession();
    io.emit('examStatusChanged', false);
    io.emit('examClosed');
    res.json({ success: true, message: 'Bài thi đã đóng' });
});

// Kiểm tra mật khẩu bắt đầu làm bài
app.post('/api/exam/verify-password', (req, res) => {
    var { password } = req.body;
    
    // Nếu không yêu cầu mật khẩu hoặc mật khẩu trống
    if (!examSettings.requirePassword || !examSettings.examPassword) {
        return res.json({ success: true, message: 'Không cần mật khẩu' });
    }
    
    // Kiểm tra mật khẩu
    if (password === examSettings.examPassword) {
        return res.json({ success: true, message: 'Mật khẩu chính xác' });
    } else {
        return res.json({ success: false, error: 'Mật khẩu không đúng!' });
    }
});

// Kiểm tra xem có yêu cầu mật khẩu không (cho client)
app.get('/api/exam/password-required', (req, res) => {
    res.json({
        required: examSettings.requirePassword && !!examSettings.examPassword
    });
});

// ========== QUẢN LÝ SESSION (LỚP + BÀI KIỂM TRA) ==========

// Lấy thông tin session hiện tại
app.get('/api/session', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    res.json({
        currentSession,
        examSettings,
        studentCount: students.length,
        resultCount: results.length
    });
});

// Cập nhật session (chọn lớp + bài)
app.post('/api/session', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { classId, examId } = req.body;
    
    // Validate class nếu có
    if (classId) {
        var classData = classesData[classId];
        if (!classData) {
            return res.json({ success: false, error: 'Không tìm thấy lớp' });
        }
        currentSession.classId = classId;
        currentSession.className = classData.name;
    }
    
    // Validate exam nếu có
    if (examId) {
        var exam = loadExam(examId);
        if (!exam) {
            return res.json({ success: false, error: 'Không tìm thấy bài kiểm tra' });
        }
        currentSession.examId = examId;
        currentSession.examName = exam.name;
        
        // Load câu hỏi từ exam
        questions = exam.questions || [];
        applyExamSettings(exam.settings);
    }
    
    saveCurrentSession();
    
    // Reload students, results, status cho session mới
    loadStudents();
    loadStudentStatus();
    loadResults();
    
    // Khởi tạo trạng thái cho học sinh mới
    students.forEach(s => {
        if (!studentStatus[s.stt]) {
            studentStatus[s.stt] = {
                selected: false,
                selectedBy: null,
                completed: false,
                canRetry: false
            };
        }
    });
    
    io.emit('sessionChanged', currentSession);
    
    res.json({ 
        success: true, 
        currentSession,
        questionCount: questions.length,
        studentCount: students.length,
        resultCount: results.length
    });
});

// ========== QUẢN LÝ LỚP ==========

// Lấy danh sách lớp
app.get('/api/classes', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    res.json({
        classes: getClassList(),
        currentClassId: currentSession.classId
    });
});

// Tạo lớp mới
app.post('/api/classes', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { name } = req.body;
    if (!name || name.trim() === '') {
        return res.json({ success: false, error: 'Vui lòng nhập tên lớp' });
    }
    
    // Kiểm tra trùng tên lớp
    var trimmedName = name.trim().toLowerCase();
    var existingClass = Object.values(classesData).find(
        c => c.name.toLowerCase() === trimmedName
    );
    if (existingClass) {
        return res.json({ success: false, error: 'Tên lớp đã tồn tại' });
    }
    
    var newClass = createClass(name.trim());
    
    res.json({ 
        success: true, 
        class: newClass,
        message: `Đã tạo lớp "${name.trim()}"`
    });
});

// Sửa tên lớp
app.put('/api/classes/:classId', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var classId = req.params.classId;
    var name = req.body.name;
    
    if (!name || name.trim() === '') {
        return res.json({ success: false, error: 'Vui lòng nhập tên lớp' });
    }
    
    if (!classesData[classId]) {
        return res.json({ success: false, error: 'Không tìm thấy lớp' });
    }
    
    // Kiểm tra trùng tên lớp (trừ chính nó)
    var trimmedName = name.trim().toLowerCase();
    var existingClass = Object.entries(classesData).find(
        function(entry) { return entry[0] !== classId && entry[1].name.toLowerCase() === trimmedName; }
    );
    if (existingClass) {
        return res.json({ success: false, error: 'Tên lớp đã tồn tại' });
    }
    
    classesData[classId].name = name.trim();
    saveClasses();
    
    // Cập nhật currentSession nếu đang dùng lớp này
    if (currentSession.classId === classId) {
        currentSession.className = name.trim();
        saveCurrentSession();
    }
    
    res.json({ 
        success: true, 
        message: 'Đã đổi tên lớp thành "' + name.trim() + '"'
    });
});

// Xóa lớp
app.delete('/api/classes/:classId', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { classId } = req.params;
    
    if (classId === currentSession.classId) {
        return res.json({ success: false, error: 'Không thể xóa lớp đang sử dụng' });
    }
    
    if (deleteClass(classId)) {
        res.json({ success: true, message: 'Đã xóa lớp' });
    } else {
        res.json({ success: false, error: 'Không tìm thấy lớp' });
    }
});

// Upload danh sách học sinh cho lớp cụ thể
app.post('/api/classes/:classId/students', upload.single('file'), (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền upload danh sách' });
    }
    
    var { classId } = req.params;
    var classData = classesData[classId];
    
    console.log(`📤 Upload danh sách cho lớp: ${classId}`);
    console.log(`📦 File: ${req.file ? req.file.originalname : 'không có'}, Size: ${req.file ? req.file.size : 0} bytes`);
    
    if (!classData) {
        return res.json({ success: false, error: 'Không tìm thấy lớp' });
    }
    
    if (!req.file || req.file.size === 0) {
        return res.json({ success: false, error: 'File rỗng hoặc không nhận được dữ liệu' });
    }
    
    try {
        var workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        var sheetName = workbook.SheetNames[0];
        var worksheet = workbook.Sheets[sheetName];

        // Thử raw rows trước (hỗ trợ file bảng điểm trường)
        var rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        var parsedStudents = parseStudentDataRaw(rawRows);
        if (!parsedStudents) {
            var data = XLSX.utils.sheet_to_json(worksheet);
            parsedStudents = parseStudentData(data);
        }

        console.log('[INFO] Sheet: ' + sheetName + ', parsed: ' + (parsedStudents ? parsedStudents.length : 0) + ' hoc sinh');

        if (!parsedStudents || parsedStudents.length === 0) {
            return res.json({ success: false, error: 'Không có học sinh hợp lệ. Kiểm tra file có cột STT, Họ, Tên không.' });
        }
        
        // Lưu danh sách đã phân tích vào storage (không lưu file Excel nhị phân)
        var filename = `${classId}.students.json`;
        DATA.writeJson(path.join(__dirname, 'data', 'class-students', filename), parsedStudents);

        // Cập nhật thông tin lớp
        classData.studentFile = filename;
        classData.studentCount = parsedStudents.length;
        saveClasses();
        
        // Nếu là lớp hiện tại, reload students
        if (classId === currentSession.classId) {
            loadStudents();
            io.emit('studentsUpdated');
        }
        
        res.json({
            success: true,
            count: parsedStudents.length,
            message: `Đã tải lên ${parsedStudents.length} học sinh cho lớp "${classData.name}"`
        });
        
    } catch (err) {
        console.error('Lỗi upload danh sách:', err);
        res.json({ success: false, error: 'Không thể đọc file Excel' });
    }
});

// ========== QUẢN LÝ BÀI KIỂM TRA ==========

// Lấy danh sách bài kiểm tra
app.get('/api/exams', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    res.json({
        currentExamId: currentSession.examId,
        exams: getSavedExams()
    });
});

// Xem nội dung 1 bài kiểm tra đã lưu (chỉ giáo viên).
// Chỉ ĐỌC, không đổi bài đang dùng — dùng để kiểm tra kết quả sau khi nhập đề.
app.get('/api/exams/:examId', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    var data = loadExam(req.params.examId);
    if (!data) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy bài kiểm tra' });
    }
    res.json({
        success: true,
        exam: {
            id: req.params.examId,
            name: data.name || req.params.examId,
            questions: data.questions || [],
            createdAt: data.createdAt || null
        }
    });
});

// Tạo bài kiểm tra mới (API ngắn gọn)
app.post('/api/exams', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { name } = req.body;
    if (!name || name.trim() === '') {
        return res.json({ success: false, error: 'Vui lòng nhập tên bài kiểm tra' });
    }
    
    // Tạo ID unique
    var examId = 'exam_' + Date.now();
    
    // Lưu bài kiểm tra trống
    var examData = {
        name: name.trim(),
        questions: [],
        settings: {
            title: name.trim(),
            timeLimit: 30,
            isOpen: false,
            showScore: true
        },
        createdAt: new Date().toISOString()
    };
    
    var dir = path.join(__dirname, 'data', 'exams');
    DATA.writeJson(path.join(dir, `${examId}.json`), examData);
    
    res.json({ 
        success: true, 
        examId,
        message: `Đã tạo bài kiểm tra "${name.trim()}"` 
    });
});

// Sửa tên bài kiểm tra
app.put('/api/exams/:examId', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var examId = req.params.examId;
    var name = req.body.name;
    
    if (!name || name.trim() === '') {
        return res.json({ success: false, error: 'Vui lòng nhập tên bài kiểm tra' });
    }
    
    var examPath = path.join(__dirname, 'data', 'exams', examId + '.json');
    var examData = DATA.readJson(examPath, null);
    if (!examData) {
        return res.json({ success: false, error: 'Không tìm thấy bài kiểm tra' });
    }

    examData.name = name.trim();
    if (examData.settings) {
        examData.settings.title = name.trim();
    }
    DATA.writeJson(examPath, examData);

    // Cập nhật currentSession nếu đang dùng bài này
    if (currentSession.examId === examId) {
        currentSession.examName = name.trim();
        examSettings.title = name.trim();
        saveCurrentSession();
    }

    res.json({ 
        success: true, 
        message: 'Đã đổi tên thành "' + name.trim() + '"'
    });
});

// Xóa bài kiểm tra
app.delete('/api/exams/:examId', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { examId } = req.params;
    
    // Không cho xóa bài đang dùng
    if (examId === currentSession.examId) {
        return res.json({ success: false, error: 'Không thể xóa bài đang sử dụng' });
    }
    
    var examPath = path.join(__dirname, 'data', 'exams', `${examId}.json`);
    if (DATA.exists(examPath)) {
        DATA.del(examPath);
        res.json({ success: true, message: 'Đã xóa bài kiểm tra' });
    } else {
        res.json({ success: false, error: 'Không tìm thấy bài kiểm tra' });
    }
});

// Lưu bài kiểm tra hiện tại
app.post('/api/exams/save', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { name } = req.body;
    if (!name || name.trim() === '') {
        return res.json({ success: false, error: 'Vui lòng nhập tên bài kiểm tra' });
    }
    
    // Tạo ID từ tên (loại bỏ ký tự đặc biệt)
    var examId = name.trim()
        .toLowerCase()
        .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
        .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
        .replace(/[ìíịỉĩ]/g, 'i')
        .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
        .replace(/[ùúụủũưừứựửữ]/g, 'u')
        .replace(/[ỳýỵỷỹ]/g, 'y')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'bai-kiem-tra';
    
    saveExam(examId, name.trim());
    
    // Cập nhật session
    currentSession.examId = examId;
    currentSession.examName = name.trim();
    saveCurrentSession();
    
    res.json({ 
        success: true, 
        examId,
        message: `Đã lưu bài kiểm tra "${name.trim()}"` 
    });
});

// Chuyển sang bài kiểm tra khác
app.post('/api/exams/switch', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { examId, resetStudents } = req.body;
    var exam = loadExam(examId);
    
    if (!exam) {
        return res.json({ success: false, error: 'Không tìm thấy bài kiểm tra' });
    }
    
    // Load câu hỏi và cài đặt từ bài kiểm tra
    questions = exam.questions || [];
    applyExamSettings(exam.settings);
    
    // Cập nhật session
    currentSession.examId = examId;
    currentSession.examName = exam.name;
    saveCurrentSession();
    
    // Reload results và student status cho session mới
    loadResults();
    loadStudentStatus();
    
    // Reset nếu được yêu cầu (khi là lớp mới hoặc muốn reset)
    if (resetStudents) {
        results = [];
        saveResults();
        
        // Reset trạng thái học sinh
        Object.keys(studentStatus).forEach(stt => {
            studentStatus[stt] = {
                selected: false,
                selectedBy: null,
                completed: false,
                canRetry: false
            };
        });
        saveStudentStatus();
    }
    
    // Lưu câu hỏi vào file chính
    saveQuestions();
    
    // Thông báo cho tất cả client
    io.emit('examSwitched', {
        examId,
        examName: exam.name,
        questionCount: questions.length
    });
    io.emit('sessionChanged', currentSession);
    
    res.json({ 
        success: true, 
        examName: exam.name,
        questionCount: questions.length,
        message: `Đã chuyển sang bài "${exam.name}" với ${questions.length} câu hỏi`
    });
});

// Tạo bài kiểm tra mới (KHÔNG chuyển sang dùng - chỉ lưu vào danh sách)
app.post('/api/exams/create', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { name } = req.body;
    if (!name || name.trim() === '') {
        return res.json({ success: false, error: 'Vui lòng nhập tên bài kiểm tra' });
    }
    
    // Tạo examId mới
    var newExamId = 'exam_' + Date.now();
    
    // Lưu bài kiểm tra mới vào file riêng (trống, chưa có câu hỏi)
    var examData = {
        id: newExamId,
        name: name.trim(),
        questions: [],
        createdAt: new Date().toISOString()
    };
    
    var examFilePath = path.join(__dirname, 'data', 'exams', `${newExamId}.json`);
    DATA.writeJson(examFilePath, examData);
    
    res.json({ 
        success: true, 
        examId: newExamId,
        message: `Đã tạo bài kiểm tra "${name.trim()}". Bài đang dùng không thay đổi.`
    });
});

// Import câu hỏi vào một bài kiểm tra cụ thể (không phải bài đang dùng)
app.post('/api/exams/:examId/import-json', upload.single('file'), (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { examId } = req.params;
    
    if (!req.file) {
        return res.json({ success: false, error: 'Không có file được upload' });
    }
    
    try {
        // Đọc nội dung file JSON
        var jsonContent = req.file.buffer.toString('utf8');
        var uploadedQuestions = JSON.parse(jsonContent);
        
        if (!Array.isArray(uploadedQuestions) || uploadedQuestions.length === 0) {
            return res.json({ success: false, error: 'File JSON không hợp lệ hoặc rỗng' });
        }
        
        // Validate câu hỏi
        var validQuestions = [];
        uploadedQuestions.forEach((q, index) => {
            var errors = [];
            var normalized = validateAndNormalizeQuestion(q, index + 1, errors);
            if (normalized) validQuestions.push(normalized);
        });
        
        if (validQuestions.length === 0) {
            return res.json({ success: false, error: 'Không có câu hỏi hợp lệ trong file' });
        }
        
        // Đọc file bài kiểm tra
        var examFilePath = path.join(__dirname, 'data', 'exams', `${examId}.json`);
        var examData = DATA.readJson(examFilePath, null);
        if (!examData) {
            return res.json({ success: false, error: 'Không tìm thấy bài kiểm tra' });
        }

        examData.questions = validQuestions;
        examData.updatedAt = new Date().toISOString();

        DATA.writeJson(examFilePath, examData);
        
        res.json({ 
            success: true, 
            count: validQuestions.length,
            message: `Đã import ${validQuestions.length} câu hỏi vào bài "${examData.name}"`
        });
        
    } catch (err) {
        console.error('Lỗi import:', err);
        res.json({ success: false, error: 'Lỗi: ' + err.message });
    }
});

// Import Word vào bài kiểm tra cụ thể
app.post('/api/exams/:examId/import-word', docxUpload.single('file'), (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { examId } = req.params;
    
    if (!req.file) {
        return res.json({ success: false, error: 'Không có file được upload' });
    }
    
    mammothToHtml(req.file.buffer).then(function(data) {
            var html = data.value;
            var warnings = [];
            var parsedQuestions = dropUnansweredShortAnswers(parseQuestionsFromHtml(html), warnings);

            if (parsedQuestions.length === 0) {
                return res.json({ success: false, error: 'Không tìm thấy câu hỏi hợp lệ trong file', warnings: warnings });
            }

            // Đọc và cập nhật bài kiểm tra
            var examFilePath = path.join(__dirname, 'data', 'exams', `${examId}.json`);
            var examData = DATA.readJson(examFilePath, null);
            if (!examData) {
                return res.json({ success: false, error: 'Không tìm thấy bài kiểm tra' });
            }

            examData.questions = parsedQuestions;
            examData.updatedAt = new Date().toISOString();

            DATA.writeJson(examFilePath, examData);

            res.json({
                success: true,
                count: parsedQuestions.length,
                warnings: warnings,
                message: `Đã import ${parsedQuestions.length} câu hỏi vào bài "${examData.name}"`
            });
        }).catch(function(err) {
            res.json({ success: false, error: 'Không thể đọc file Word: ' + err.message });
        });
});

// Tạo bài kiểm tra mới và CHUYỂN SANG DÙNG NGAY (cũ - giữ lại để tương thích)
app.post('/api/exams/new', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { name, resetStudents } = req.body;
    if (!name || name.trim() === '') {
        return res.json({ success: false, error: 'Vui lòng nhập tên bài kiểm tra' });
    }
    
    // Tạo examId mới
    var newExamId = 'exam_' + Date.now();
    
    // Reset câu hỏi
    questions = [];
    examSettings.title = name.trim();
    examSettings.isOpen = false;
    
    // Cập nhật session
    currentSession.examId = newExamId;
    currentSession.examName = name.trim();
    saveCurrentSession();
    
    // Reset kết quả nếu được yêu cầu
    if (resetStudents) {
        results = [];
        saveResults();
        
        Object.keys(studentStatus).forEach(stt => {
            studentStatus[stt] = {
                selected: false,
                selectedBy: null,
                completed: false,
                canRetry: false
            };
        });
        saveStudentStatus();
    }
    
    saveQuestions();
    
    io.emit('examSwitched', {
        examId: newExamId,
        examName: name.trim(),
        questionCount: 0
    });
    io.emit('sessionChanged', currentSession);
    
    res.json({ 
        success: true, 
        message: `Đã tạo bài kiểm tra mới "${name.trim()}". Hãy thêm câu hỏi!`
    });
});

// ========== END QUẢN LÝ BÀI KIỂM TRA ==========

// ========== API DANH SÁCH ÔN TẬP ==========

function teacherReviewSummary(list) {
    var items = (list.items || []).map(function (item) {
        return publicReviewExam(item.examId, item.settings);
    });
    var attemptCount = 0;
    (list.items || []).forEach(function (item) {
        attemptCount += loadReviewAttempts(list.id, item.examId).filter(function (a) {
            return a && a.status === 'submitted';
        }).length;
    });
    return {
        id: list.id,
        name: list.name,
        description: list.description || '',
        subject: list.subject || '',
        active: list.active !== false,
        itemCount: items.length,
        attemptCount: attemptCount,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt
    };
}

// --- Giáo viên: quản lý danh sách ---
app.get('/api/review-lists', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền truy cập' });
    var lists = Object.keys(reviewLists).map(function (id) {
        return teacherReviewSummary(reviewLists[id]);
    }).sort(function (a, b) {
        return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
    res.json({ lists: lists });
});

app.get('/api/review-lists/:listId', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền truy cập' });
    var list = getReviewList(req.params.listId);
    if (!list) return res.status(404).json({ error: 'Không tìm thấy danh sách ôn tập' });
    res.json({ success: true, list: list });
});

app.post('/api/review-lists', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền thực hiện' });
    var name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Vui lòng nhập tên danh sách' });
    var id = 'review_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var now = new Date().toISOString();
    reviewLists[id] = {
        id: id,
        name: name.substring(0, 160),
        description: String((req.body && req.body.description) || '').trim().substring(0, 2000),
        subject: String((req.body && req.body.subject) || '').trim().substring(0, 120),
        active: req.body && req.body.active === false ? false : true,
        items: [],
        createdAt: now,
        updatedAt: now
    };
    saveReviewLists();
    res.json({ success: true, list: reviewLists[id] });
});

app.put('/api/review-lists/:listId', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền thực hiện' });
    var list = getReviewList(req.params.listId);
    if (!list) return res.status(404).json({ error: 'Không tìm thấy danh sách ôn tập' });
    var body = req.body || {};

    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        var name = String(body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Vui lòng nhập tên danh sách' });
        list.name = name.substring(0, 160);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
        list.description = String(body.description || '').trim().substring(0, 2000);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'subject')) {
        list.subject = String(body.subject || '').trim().substring(0, 120);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'active')) {
        list.active = body.active !== false;
    }

    if (Array.isArray(body.items)) {
        for (var vi = 0; vi < body.items.length; vi++) {
            var rawItem = body.items[vi];
            if (!rawItem || !rawItem.examId) continue;
            var settingsError = review.validateSettings(rawItem.settings);
            if (settingsError) return res.status(400).json({ error: settingsError });
        }
        var currentIds = (list.items || []).map(function (item) { return String(item.examId); });
        var seen = {};
        var items = [];
        body.items.forEach(function (raw) {
            if (!raw || !raw.examId) return;
            var examId = String(raw.examId);
            if (!isSafeId(examId) || seen[examId]) return;
            var exam = loadExam(examId);
            // Đề đã bị xóa vẫn được giữ nếu đang có trong danh sách (UI hiện cảnh báo).
            if (!exam && currentIds.indexOf(examId) === -1) return;
            seen[examId] = true;
            items.push({
                examId: examId,
                settings: review.normalizeSettings(raw.settings, exam)
            });
        });
        list.items = items;
    }

    list.updatedAt = new Date().toISOString();
    saveReviewLists();
    res.json({ success: true, list: list });
});

app.delete('/api/review-lists/:listId', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền thực hiện' });
    var list = getReviewList(req.params.listId);
    if (!list) return res.status(404).json({ error: 'Không tìm thấy danh sách ôn tập' });
    // Chỉ xóa danh sách; giữ file lịch sử làm bài để không mất dữ liệu cũ.
    delete reviewLists[list.id];
    saveReviewLists();
    res.json({ success: true });
});

app.get('/api/review-lists/:listId/results', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền truy cập' });
    var list = getReviewList(req.params.listId);
    if (!list) return res.status(404).json({ error: 'Không tìm thấy danh sách ôn tập' });
    var exams = (list.items || []).map(function (item) {
        var info = publicReviewExam(item.examId, item.settings);
        var rawAttempts = loadReviewAttempts(list.id, item.examId);
        // Dữ liệu cũ có thể thiếu trường no: đánh số theo thứ tự bắt đầu.
        var noById = {};
        var byStudent = {};
        rawAttempts.forEach(function (a) {
            if (!a) return;
            var key = String(a.studentSTT);
            (byStudent[key] = byStudent[key] || []).push(a);
        });
        Object.keys(byStudent).forEach(function (key) {
            byStudent[key].sort(function (a, b) {
                return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
            }).forEach(function (a, index) {
                noById[a.id] = index + 1;
            });
        });
        var attempts = rawAttempts.filter(function (a) {
            return a && a.status === 'submitted';
        }).map(function (a) {
            return {
                id: a.id,
                studentSTT: a.studentSTT,
                studentName: a.studentName,
                studentClass: a.studentClass,
                attemptNo: a.no || noById[a.id] || null,
                score: a.score,
                maxScore: a.maxScore,
                correctCount: a.correctCount,
                totalQuestions: a.totalQuestions,
                timeSpent: a.timeSpent,
                submittedAt: a.submittedAt,
                fsExitCount: typeof a.fsExitCount === 'number' ? a.fsExitCount : null,
                tabSwitchCount: typeof a.tabSwitchCount === 'number' ? a.tabSwitchCount : null
            };
        });
        info.attempts = attempts;
        // Bảng tổng hợp theo từng học sinh: giữ đủ lịch sử, học sinh chưa làm
        // vẫn có mặt nếu thuộc lớp hiện tại hoặc đã từng làm bài.
        var built = review.buildExamResults(rawAttempts, reviewRoster(), currentSession.className || '');
        info.students = built.students;
        info.summary = built.summary;
        info.rosterClassName = currentSession.className || '';
        return info;
    });
    res.json({ success: true, list: { id: list.id, name: list.name }, exams: exams });
});

// Xuất kết quả ôn tập của một đề ra Excel (.xlsx).
app.get('/api/review-lists/:listId/results/export', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền xuất kết quả' });
    var list = getReviewList(req.params.listId);
    if (!list) return res.status(404).json({ error: 'Không tìm thấy danh sách ôn tập' });
    var item = findReviewItem(list, req.query.examId);
    if (!item) return res.status(404).json({ error: 'Đề không thuộc danh sách này' });

    var examInfo = publicReviewExam(item.examId, item.settings);
    var built = review.buildExamResults(
        loadReviewAttempts(list.id, item.examId),
        reviewRoster(),
        currentSession.className || ''
    );
    if (!built.students.length) {
        return res.status(409).json({ error: 'Chưa có học sinh nào trong phạm vi bài ôn tập để xuất.' });
    }

    var table = review.resultTable(built.students);
    var ws = XLSX.utils.aoa_to_sheet([table.headers].concat(table.rows));
    var cols = [{ wch: 5 }, { wch: 28 }, { wch: 12 }];
    for (var i = 0; i < table.maxAttempts; i++) cols.push({ wch: 10 });
    cols.push({ wch: 18 }, { wch: 12 }, { wch: 20 }, { wch: 18 });
    ws['!cols'] = cols;
    ws['!autofilter'] = {
        ref: XLSX.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: table.rows.length, c: table.headers.length - 1 }
        })
    };

    var wb = XLSX.utils.book_new();
    wb.Props = {
        Title: 'Kết quả ôn tập - ' + examInfo.examName,
        Author: 'Trac nghiem'
    };
    XLSX.utils.book_append_sheet(wb, ws, 'Ket qua');

    var now = new Date();
    var dateParts = [
        String(now.getDate()).padStart(2, '0'),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getFullYear())
    ];
    var dateStr = dateParts.join('-');
    var asciiName = 'Ket_qua_on_tap_' + slugFileName(examInfo.examName) + '_' + dateStr + '.xlsx';
    var utf8Name = 'Ket_qua_on_tap_' +
        String(examInfo.examName || 'bai_on_tap').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) +
        '_' + dateStr + '.xlsx';

    var buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
        'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(utf8Name));
    res.send(buffer);
});

// Ten file ASCII: bo dau tieng Viet, chi giu chu/so va gach duoi.
function slugFileName(name) {
    return String(name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'bai_on_tap';
}

// --- Học sinh: xem danh sách và tự chọn đề ---
app.get('/api/review/students', function (req, res) {
    res.json({
        students: students.map(function (s) {
            return { stt: s.stt, fullName: studentFullName(s) };
        }),
        className: currentSession.className || ''
    });
});

app.get('/api/review/lists', function (req, res) {
    var lists = Object.keys(reviewLists).map(function (id) {
        var list = reviewLists[id];
        if (list.active === false) return null;
        return {
            id: list.id,
            name: list.name,
            description: list.description || '',
            subject: list.subject || '',
            itemCount: (list.items || []).length,
            updatedAt: list.updatedAt
        };
    }).filter(Boolean).sort(function (a, b) {
        return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
    res.json({ lists: lists });
});

app.get('/api/review/lists/:listId', function (req, res) {
    var list = getReviewList(req.params.listId);
    if (!list || list.active === false) {
        return res.status(404).json({ error: 'Danh sách ôn tập không tồn tại hoặc đã bị tắt' });
    }
    var stt = req.query.stt;
    if (stt && !findStudentByStt(stt)) {
        return res.status(404).json({ error: 'Không tìm thấy học sinh' });
    }
    res.json({ success: true, list: buildReviewListPayload(list, stt) });
});

app.get('/api/review/history', function (req, res) {
    var list = getReviewList(req.query.listId);
    if (!list || list.active === false) {
        return res.status(404).json({ error: 'Danh sách ôn tập không tồn tại hoặc đã bị tắt' });
    }
    var item = findReviewItem(list, req.query.examId);
    if (!item) return res.status(404).json({ error: 'Đề không thuộc danh sách này' });
    var student = findStudentByStt(req.query.stt);
    if (!student) return res.status(404).json({ error: 'Không tìm thấy học sinh' });

    var attempts = loadReviewAttempts(list.id, item.examId);
    var summary = review.summarize(attempts, student.stt);
    var settings = item.settings;
    var canViewDetails = settings.showResult || settings.showAnswers;

    // Số thứ tự lượt theo thời điểm bắt đầu (kể cả lượt bỏ dở) để không đánh
    // số lại lịch sử cũ.
    var noById = {};
    attempts.filter(function (a) {
        return a && String(a.studentSTT) === String(student.stt);
    }).sort(function (a, b) {
        return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
    }).forEach(function (a, index) {
        noById[a.id] = index + 1;
    });

    var publicAttempts = attempts.filter(function (a) {
        return a && a.status === 'submitted' && String(a.studentSTT) === String(student.stt);
    }).sort(function (a, b) {
        return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime();
    }).map(function (a) {
        return {
            id: a.id,
            attemptNo: a.no || noById[a.id] || null,
            score: a.score,
            maxScore: a.maxScore,
            correctCount: a.correctCount,
            partialCount: a.partialCount,
            wrongCount: a.wrongCount,
            unansweredCount: a.unansweredCount,
            totalQuestions: a.totalQuestions,
            timeSpent: a.timeSpent,
            submittedAt: a.submittedAt,
            expired: !!a.expired,
            fsExitCount: typeof a.fsExitCount === 'number' ? a.fsExitCount : null,
            tabSwitchCount: typeof a.tabSwitchCount === 'number' ? a.tabSwitchCount : null,
            canViewDetails: canViewDetails,
            details: canViewDetails ? filterHistoryDetails(settings, a.details) : null
        };
    });

    res.json({
        success: true,
        list: { id: list.id, name: list.name },
        exam: { id: item.examId, name: (loadExam(item.examId) || {}).name || '[Đề đã bị xóa]' },
        settings: reviewSettingsPayload(settings),
        summary: summary,
        attempts: publicAttempts
    });
});

app.get('/api/review/play', function (req, res) {
    var list = getReviewList(req.query.listId);
    if (!list || list.active === false) {
        return res.status(404).json({ error: 'Danh sách ôn tập không tồn tại hoặc đã bị tắt' });
    }
    var item = findReviewItem(list, req.query.examId);
    if (!item) return res.status(404).json({ error: 'Đề không thuộc danh sách này' });
    var exam = loadExam(item.examId);
    if (!exam || !Array.isArray(exam.questions) || exam.questions.length === 0) {
        return res.status(409).json({ error: 'Đề này không còn khả dụng' });
    }
    var student = findStudentByStt(req.query.stt);
    if (!student) return res.status(404).json({ error: 'Không tìm thấy học sinh' });

    var attempts = loadReviewAttempts(list.id, item.examId);
    var now = Date.now();
    var plan = review.planAttempt(attempts, item.settings, student.stt, now);

    // Lượt dở đã quá hạn: đóng và chấm với 0 câu trả lời (server không giữ
    // tiến độ), để lượt đó vẫn được tính vào giới hạn.
    if (plan.action === 'close') {
        settleReviewAttempt(plan.attempt, exam.questions, {}, item.settings, true);
        saveReviewAttempts(list.id, item.examId, attempts);
        plan = review.planAttempt(attempts, item.settings, student.stt, Date.now());
    }
    if (plan.action === 'deny') {
        return res.status(429).json({ error: 'Bạn đã hết lượt làm đề này' });
    }

    var active = plan.attempt;
    if (!active) {
        active = {
            id: 'att_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            listId: list.id,
            examId: item.examId,
            studentSTT: student.stt,
            studentName: studentFullName(student),
            studentClass: currentSession.className || 'Ôn tập',
            status: 'active',
            no: review.countAttempts(attempts, student.stt) + 1,
            timeLimit: item.settings.timeLimit,
            startedAt: new Date(now).toISOString()
        };
        attempts.push(active);
        saveReviewAttempts(list.id, item.examId, attempts);
    }

    var attemptsUsed = review.countAttempts(attempts, student.stt);
    var playSettings = reviewSettingsPayload(item.settings);
    // Dùng đúng thời gian đã chốt cho lượt này (kể cả khi giáo viên vừa sửa đề).
    playSettings.timeLimit = review.attemptTimeLimit(active, item.settings);
    res.json({
        success: true,
        list: { id: list.id, name: list.name, description: list.description || '', subject: list.subject || '' },
        student: {
            stt: student.stt,
            name: studentFullName(student),
            className: currentSession.className || 'Ôn tập'
        },
        exam: {
            id: item.examId,
            name: exam.name || item.examId,
            questionCount: exam.questions.length,
            questions: sanitizeExamForStudent(exam.questions)
        },
        settings: playSettings,
        attempt: { id: active.id, startedAt: active.startedAt },
        serverNow: now,
        attemptsUsed: attemptsUsed,
        remainingAttempts: item.settings.maxAttempts > 0
            ? Math.max(0, item.settings.maxAttempts - attemptsUsed)
            : null
    });
});

// Chi nhan bo dem vi pham dang so nguyen khong am, chan gia tri rac tu client.
function toViolationCount(value) {
    var n = Math.floor(Number(value));
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(n, 9999);
}

app.post('/api/review/submit', function (req, res) {
    var body = req.body || {};
    var list = getReviewList(body.listId);
    if (!list) return res.status(404).json({ error: 'Không tìm thấy danh sách ôn tập' });
    var item = findReviewItem(list, body.examId);
    if (!item) return res.status(404).json({ error: 'Đề không thuộc danh sách này' });
    var exam = loadExam(item.examId);
    if (!exam || !Array.isArray(exam.questions) || exam.questions.length === 0) {
        return res.status(409).json({ error: 'Đề này không còn khả dụng' });
    }
    var student = findStudentByStt(body.stt);
    if (!student) return res.status(404).json({ error: 'Không tìm thấy học sinh' });

    var attempts = loadReviewAttempts(list.id, item.examId);
    var attempt = null;
    for (var i = 0; i < attempts.length; i++) {
        if (attempts[i] && attempts[i].id === body.attemptId &&
            attempts[i].status === 'active' &&
            String(attempts[i].studentSTT) === String(student.stt)) {
            attempt = attempts[i];
            break;
        }
    }
    if (!attempt) {
        return res.status(409).json({ error: 'Lượt làm bài không hợp lệ hoặc đã được nộp' });
    }

    var elapsedSec = Math.max(0, Math.floor((Date.now() - new Date(attempt.startedAt).getTime()) / 1000));
    var limit = review.attemptTimeLimit(attempt, item.settings);
    var late = limit > 0 && elapsedSec > limit * 60 + 120;

    // Quá hạn + 2 phút ân hạn: vẫn đóng lượt và lưu kết quả (0 câu trả lời)
    // thay vì để lượt treo, nhưng không chấp nhận đáp án gửi muộn.
    if (late) {
        var expiredGraded = settleReviewAttempt(attempt, exam.questions, {}, item.settings, true);
        attempt.fsExitCount = toViolationCount(body.violations && body.violations.fsExitCount);
        attempt.tabSwitchCount = toViolationCount(body.violations && body.violations.tabSwitchCount);
        saveReviewAttempts(list.id, item.examId, attempts);
        var expiredUsed = review.countAttempts(attempts, student.stt);
        return res.json({
            success: true,
            expired: true,
            score: expiredGraded.score,
            maxScore: expiredGraded.maxScore,
            correctCount: expiredGraded.correctCount,
            partialCount: expiredGraded.partialCount,
            wrongCount: expiredGraded.wrongCount,
            unansweredCount: expiredGraded.unansweredCount,
            totalQuestions: expiredGraded.totalQuestions,
            showScore: true,
            showAnswers: item.settings.showAnswers,
            attemptsUsed: expiredUsed,
            remainingAttempts: item.settings.maxAttempts > 0
                ? Math.max(0, item.settings.maxAttempts - expiredUsed)
                : null
        });
    }

    var graded = settleReviewAttempt(attempt, exam.questions, body.answers, item.settings, false);
    attempt.fsExitCount = toViolationCount(body.violations && body.violations.fsExitCount);
    attempt.tabSwitchCount = toViolationCount(body.violations && body.violations.tabSwitchCount);
    saveReviewAttempts(list.id, item.examId, attempts);

    var usedCount = review.countAttempts(attempts, student.stt);
    res.json({
        success: true,
        score: graded.score,
        maxScore: graded.maxScore,
        correctCount: graded.correctCount,
        partialCount: graded.partialCount,
        wrongCount: graded.wrongCount,
        unansweredCount: graded.unansweredCount,
        totalQuestions: graded.totalQuestions,
        showScore: true,
        showAnswers: item.settings.showAnswers,
        attemptsUsed: usedCount,
        remainingAttempts: item.settings.maxAttempts > 0
            ? Math.max(0, item.settings.maxAttempts - usedCount)
            : null
    });
});

app.post('/api/review/check-answer', function (req, res) {
    var body = req.body || {};
    var list = getReviewList(body.listId);
    if (!list || list.active === false) {
        return res.status(404).json({ error: 'Danh sách ôn tập không tồn tại hoặc đã bị tắt' });
    }
    var item = findReviewItem(list, body.examId);
    if (!item || !item.settings.practiceMode) {
        return res.status(403).json({ error: 'Chế độ xem đáp án ngay chưa được bật cho đề này' });
    }
    var exam = loadExam(item.examId);
    if (!exam || !Array.isArray(exam.questions)) {
        return res.status(409).json({ error: 'Đề này không còn khả dụng' });
    }
    var student = findStudentByStt(body.stt);
    if (!student) return res.status(404).json({ error: 'Không tìm thấy học sinh' });

    var attempts = loadReviewAttempts(list.id, item.examId);
    var active = review.findActiveAttempt(attempts, student.stt);
    if (!active) return res.status(403).json({ error: 'Bạn chưa bắt đầu lượt làm bài này' });
    if (review.isOverDeadline(item.settings, active, Date.now())) {
        return res.status(409).json({ error: 'Đã hết thời gian làm bài của lượt này' });
    }

    var questionIndex = parseInt(body.questionIndex, 10);
    if (isNaN(questionIndex) || questionIndex < 0 || questionIndex >= exam.questions.length) {
        return res.status(400).json({ error: 'Câu hỏi không hợp lệ' });
    }
    var q = migrateQuestion(exam.questions[questionIndex]);
    var questionScore = scoreQuestion(q, body.answer);
    res.json({
        isCorrect: questionScore === 1,
        questionScore: questionScore,
        type: q.type || 'single',
        correctAnswer: q.correct,
        correctAnswerText: (q.type === 'shortanswer') ? (q.correctAnswer || null) : null,
        correctList: q.correctList || null,
        correctTF: q.correctTF || null,
        yourAnswer: body.answer
    });
});

// ========== CHẤM ĐIỂM ==========
// Chấm điểm một đề bất kỳ. Dùng chung cho thi chính thức và ôn tập.
// opts.snapshot = true để lưu nội dung câu hỏi/đáp án phục vụ xem lại.
function gradeQuestions(questionList, answers, opts) {
    return grading.grade((questionList || []).map(migrateQuestion), answers, opts);
}

// Nộp bài
app.post('/api/submit', (req, res) => {
    var { studentSTT, studentName, studentClass, answers, timeSpent } = req.body;
    
    // Kiểm tra học sinh đã nộp bài chưa (không cho nộp lại trừ khi được phép)
    if (studentSTT && studentStatus[studentSTT] && studentStatus[studentSTT].completed && !studentStatus[studentSTT].canRetry) {
        return res.json({ 
            success: false, 
            error: 'Bạn đã nộp bài rồi. Không thể nộp lại!' 
        });
    }
    
    var graded = gradeQuestions(questions, answers);
    var result = {
        studentSTT,
        studentName,
        studentClass,
        score: graded.score,
        maxScore: graded.maxScore,
        correctCount: graded.correctCount,
        partialCount: graded.partialCount,
        wrongCount: graded.wrongCount,
        unansweredCount: graded.unansweredCount,
        totalQuestions: graded.totalQuestions,
        timeSpent,
        submittedAt: new Date().toLocaleString('vi-VN'),
        details: graded.details
    };
    
    // Tìm và cập nhật kết quả cũ nếu có, hoặc thêm mới
    var existingIndex = results.findIndex(r => r.studentSTT == studentSTT);
    if (existingIndex >= 0) {
        results[existingIndex] = result;
        io.emit('resultUpdated', result);
    } else {
        results.push(result);
        io.emit('newResult', result);
    }
    saveResults();
    
    // Đánh dấu học sinh đã hoàn thành
    if (studentSTT && studentStatus[studentSTT]) {
        studentStatus[studentSTT].completed = true;
        studentStatus[studentSTT].selected = false;
        studentStatus[studentSTT].selectedBy = null;
        studentStatus[studentSTT].canRetry = false;
        saveStudentStatus();

        io.emit('studentStatusUpdated', { stt: studentSTT, status: studentStatus[studentSTT] });
    }

    // Xóa server progress sau khi nộp bài
    if (serverProgress[String(studentSTT)]) {
        delete serverProgress[String(studentSTT)];
        saveServerProgress();
    }
    
    res.json({
        success: true,
        score: graded.score,
        maxScore: graded.maxScore,
        correctCount: graded.correctCount,
        partialCount: graded.partialCount,
        wrongCount: graded.wrongCount,
        unansweredCount: graded.unansweredCount,
        totalQuestions: graded.totalQuestions,
        showScore: examSettings.showScore
    });
});

// Lấy kết quả (cho giáo viên)
app.get('/api/results', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập kết quả' });
    }
    res.json(results);
});

// Xóa tất cả kết quả
app.delete('/api/results', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền xóa kết quả' });
    }
    results = [];
    saveResults();
    io.emit('resultsCleared');
    res.json({ success: true });
});

// Xuất kết quả ra Excel
app.get('/api/results/export', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền xuất kết quả' });
    }
    
    // Hàm bỏ dấu tiếng Việt
    function removeVietnameseTones(str) {
        return str
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'D')
            .replace(/[^a-zA-Z0-9]/g, '')
            .trim();
    }
    
    // Tạo tên file: TenLop_TenBai_NgayThang
    var className = currentSession.className || 'ChuaChonLop';
    var examName = currentSession.examName || 'ChuaChonBai';
    var now = new Date();
    var dateStr = `${now.getDate().toString().padStart(2, '0')}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getFullYear()}`;
    
    var fileName = `${removeVietnameseTones(className)}_${removeVietnameseTones(examName)}_${dateStr}.xlsx`;
    
    // Tạo dữ liệu cho Excel theo danh sách đầy đủ học sinh trong lớp
    // Sắp xếp theo STT, học sinh chưa thi thì để trống điểm
    var excelData = [];
    
    // Lấy danh sách học sinh, sắp xếp theo STT
    var sortedStudents = copyArray(students).sort(function(a, b) { return a.stt - b.stt; });
    
    for (var i = 0; i < sortedStudents.length; i++) {
        var student = sortedStudents[i];
        // Tìm kết quả của học sinh này (theo STT)
        var result = results.find(function(r) { return String(r.studentSTT) === String(student.stt); });
        
        // Ghép họ + tên thành họ tên đầy đủ
        var fullName = [student.ho, student.ten].filter(Boolean).join(' ').trim();
        
        if (result) {
            var submitOrder = results.indexOf(result) + 1;
            // Học sinh đã thi - có điểm
            excelData.push({
                'STT': student.stt,
                'Họ tên': fullName || result.studentName || '',
                'Lớp': result.studentClass || student.lop || '',
                'TT nộp': submitOrder,
                'Điểm': result.score,
                'Đúng HT': result.correctCount,
                'Đúng 1 phần': result.partialCount || 0,
                'Sai': result.wrongCount || 0,
                'Chưa TL': result.unansweredCount || 0,
                'Tổng câu': result.totalQuestions,
                'Thời gian làm': result.timeSpent,
                'Nộp lúc': result.submittedAt
            });
        } else {
            // Học sinh chưa thi - để trống điểm
            excelData.push({
                'STT': student.stt,
                'Họ tên': fullName,
                'Lớp': student.lop || '',
                'TT nộp': '',
                'Điểm': '',
                'Đúng HT': '',
                'Đúng 1 phần': '',
                'Sai': '',
                'Chưa TL': '',
                'Tổng câu': '',
                'Thời gian làm': '',
                'Nộp lúc': ''
            });
        }
    }

    // Tạo worksheet và workbook
    var ws = XLSX.utils.json_to_sheet(excelData);
    ws['!cols'] = [
        { wch: 5 },   // STT
        { wch: 25 },  // Họ tên
        { wch: 12 },  // Lớp
        { wch: 8 },   // TT nộp
        { wch: 8 },   // Điểm
        { wch: 10 },  // Đúng HT
        { wch: 12 },  // Đúng 1 phần
        { wch: 8 },   // Sai
        { wch: 10 },  // Chưa TL
        { wch: 10 },  // Tổng câu
        { wch: 15 },  // Thời gian làm
        { wch: 20 }   // Nộp lúc
    ];
    
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'KetQua');
    
    var buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
});

// Download mẫu file Excel danh sách học sinh - Mẫu đầy đủ (STT, HO, TEN, NU)
app.get('/api/sample-excel', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền tải file mẫu' });
    }
    
    var sampleData = [
        { STT: 1, HO: 'Nguyễn Văn', TEN: 'An', NU: '' },
        { STT: 2, HO: 'Trần Thị', TEN: 'Bình', NU: 'X' },
        { STT: 3, HO: 'Lê Hoàng', TEN: 'Cường', NU: '' },
        { STT: 4, HO: 'Phạm Thị', TEN: 'Dung', NU: 'X' },
        { STT: 5, HO: 'Hoàng Văn', TEN: 'Em', NU: '' }
    ];
    
    var ws = XLSX.utils.json_to_sheet(sampleData);
    ws['!cols'] = [{ wch: 5 }, { wch: 20 }, { wch: 15 }, { wch: 5 }];
    
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DanhSach');
    
    var buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=mau-daydu-stt-ho-ten-nu.xlsx');
    res.send(buffer);
});

// Download mẫu file Excel - Mẫu phổ biến (STT, TEN, NU)
app.get('/api/sample-excel-2', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền tải file mẫu' });
    }
    
    var sampleData = [
        { STT: 1, TEN: 'Nguyễn Văn An', NU: '' },
        { STT: 2, TEN: 'Trần Thị Bình', NU: 'X' },
        { STT: 3, TEN: 'Lê Hoàng Cường', NU: '' },
        { STT: 4, TEN: 'Phạm Thị Dung', NU: 'X' },
        { STT: 5, TEN: 'Hoàng Văn Em', NU: '' }
    ];
    
    var ws = XLSX.utils.json_to_sheet(sampleData);
    ws['!cols'] = [{ wch: 5 }, { wch: 25 }, { wch: 5 }];
    
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DanhSach');
    
    var buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=mau-phobien-stt-ten-nu.xlsx');
    res.send(buffer);
});

// Download mẫu file Excel - Mẫu đơn giản (STT, TEN)
app.get('/api/sample-excel-3', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền tải file mẫu' });
    }
    
    var sampleData = [
        { STT: 1, TEN: 'Nguyễn Văn An' },
        { STT: 2, TEN: 'Trần Thị Bình' },
        { STT: 3, TEN: 'Lê Hoàng Cường' },
        { STT: 4, TEN: 'Phạm Thị Dung' },
        { STT: 5, TEN: 'Hoàng Văn Em' }
    ];
    
    var ws = XLSX.utils.json_to_sheet(sampleData);
    ws['!cols'] = [{ wch: 5 }, { wch: 25 }];
    
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DanhSach');
    
    var buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=mau-dongian-stt-ten.xlsx');
    res.send(buffer);
});

// Upload danh sách học sinh từ Excel
app.post('/api/upload-students', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền upload danh sách' });
    }
    
    try {
        // Đọc file Excel từ buffer
        var workbook = XLSX.read(req.body, { type: 'buffer' });
        var sheetName = workbook.SheetNames[0];
        var worksheet = workbook.Sheets[sheetName];

        // Thử raw rows trước (hỗ trợ file bảng điểm trường)
        var rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        var parsedStudents = parseStudentDataRaw(rawRows);
        var errors = [];
        if (!parsedStudents) {
            // Fallback: đọc theo header tự động
            var data = XLSX.utils.sheet_to_json(worksheet);
            if (!data || data.length === 0) {
                return res.json({ success: false, error: 'File Excel trống hoặc không đọc được dữ liệu.' });
            }
            parsedStudents = parseStudentData(data);
        }

        if (!parsedStudents || parsedStudents.length === 0) {
            return res.json({
                success: false,
                error: 'Không có học sinh hợp lệ. File cần có cột STT, Họ, Tên (hoặc định dạng bảng điểm trường).',
                details: errors
            });
        }
        
        // Lưu danh sách đã phân tích vào storage (không lưu file Excel nhị phân)
        DATA.writeJson(path.join(__dirname, 'data', 'default-students.json'), parsedStudents);

        // Reload danh sách học sinh
        loadStudents();
        
        // Phát sự kiện cập nhật
        io.emit('studentsUpdated');
        
        res.json({
            success: true,
            count: parsedStudents.length,
            warnings: errors.length > 0 ? errors : null,
            message: `Đã tải lên ${parsedStudents.length} học sinh thành công!`
        });
        
    } catch (err) {
        console.error('Lỗi upload danh sách học sinh:', err);
        res.json({
            success: false,
            error: 'Không thể đọc file. Đảm bảo file là định dạng Excel (.xlsx hoặc .xls).'
        });
    }
});

// Upload câu hỏi từ file JSON (qua FormData)
app.post('/api/import-json-file', upload.single('file'), (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền upload câu hỏi' });
    }
    
    if (!req.file) {
        return res.json({ success: false, error: 'Không có file được upload' });
    }
    
    try {
        // Đọc nội dung file JSON từ buffer
        var jsonContent = req.file.buffer.toString('utf8');
        var uploadedQuestions = JSON.parse(jsonContent);
        
        // Kiểm tra dữ liệu
        if (!Array.isArray(uploadedQuestions)) {
            return res.json({
                success: false,
                error: 'File JSON không hợp lệ. Phải là một mảng các câu hỏi.'
            });
        }
        
        if (uploadedQuestions.length === 0) {
            return res.json({
                success: false,
                error: 'File JSON không có câu hỏi nào.'
            });
        }
        
        // Validate và import câu hỏi
        var validQuestions = [];
        var errors = [];

        uploadedQuestions.forEach((q, index) => {
            var qErrors = [];
            var normalized = validateAndNormalizeQuestion(q, index + 1, qErrors);
            if (normalized) {
                validQuestions.push(normalized);
            } else {
                errors = errors.concat(qErrors);
            }
        });
        
        if (validQuestions.length === 0) {
            return res.json({
                success: false,
                error: 'Không có câu hỏi hợp lệ. ' + errors.slice(0, 3).join('; ')
            });
        }
        
        // Thêm vào danh sách câu hỏi hiện tại
        questions = validQuestions;
        saveQuestions();
        
        io.emit('questionsUpdated', questions.length);
        
        res.json({
            success: true,
            count: validQuestions.length,
            errors: errors.length > 0 ? errors.slice(0, 5) : undefined
        });
        
    } catch (err) {
        console.error('Lỗi import JSON:', err);
        res.json({
            success: false,
            error: 'File JSON không hợp lệ: ' + err.message
        });
    }
});

// Upload câu hỏi từ file JSON (cũ - qua body)
app.post('/api/upload-questions-json', express.json({ limit: '10mb' }), (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền upload câu hỏi' });
    }
    
    try {
        var uploadedQuestions = req.body;
        
        // Kiểm tra dữ liệu
        if (!Array.isArray(uploadedQuestions)) {
            return res.json({
                success: false,
                error: 'File JSON không hợp lệ. Phải là một mảng các câu hỏi.'
            });
        }
        
        if (uploadedQuestions.length === 0) {
            return res.json({
                success: false,
                error: 'File JSON không có câu hỏi nào.'
            });
        }
        
        // Validate từng câu hỏi
        var validQuestions = [];
        var errors = [];

        uploadedQuestions.forEach((q, index) => {
            var qErrors = [];
            var normalized = validateAndNormalizeQuestion(q, index + 1, qErrors);
            if (normalized) {
                validQuestions.push(normalized);
            } else {
                errors = errors.concat(qErrors);
            }
        });
        
        if (validQuestions.length === 0) {
            return res.json({
                success: false,
                error: 'Không có câu hỏi hợp lệ trong file.',
                details: errors
            });
        }
        
        // Thêm vào danh sách câu hỏi
        questions = questions.concat(validQuestions);
        saveQuestions();
        
        io.emit('questionsUpdated', questions.length);
        
        res.json({
            success: true,
            imported: validQuestions.length,
            total: questions.length,
            warnings: errors.length > 0 ? errors : null,
            message: `Đã import ${validQuestions.length} câu hỏi thành công!`
        });
        
    } catch (err) {
        console.error('Lỗi upload câu hỏi JSON:', err);
        res.json({
            success: false,
            error: 'Không thể đọc file JSON. Kiểm tra định dạng file.'
        });
    }
});

// Preview câu hỏi từ file Word (không lưu, trả về để xác nhận)
app.post('/api/preview-word', docxUpload.single('file'), function(req, res) {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền' });
    }
    if (!req.file || req.file.size === 0) {
        return res.json({ success: false, error: 'Không nhận được file' });
    }
    mammothToHtml(req.file.buffer).then(function(result) {
        var html = result.value;
        var parsed = parseQuestionsFromHtml(html);
        var warnings = [];
        // Kiểm tra từng câu và thu thập cảnh báo
        parsed.forEach(function(q, i) {
            var num = i + 1;
            var type = q.type || 'single';
            if (!q.question || q.question.trim() === '') {
                warnings.push({ index: i, msg: 'Câu ' + num + ': Thiếu nội dung câu hỏi' });
            }
            if (type !== 'shortanswer' && (!q.options || q.options.length < 2)) {
                warnings.push({ index: i, msg: 'Câu ' + num + ': Chỉ có ' + (q.options ? q.options.length : 0) + ' đáp án (cần ít nhất 2)' });
            }
            if (type === 'single' && (q.correct === undefined || q.correct < 0)) {
                warnings.push({ index: i, msg: 'Câu ' + num + ': Không tìm thấy đáp án đúng (thêm dấu * sau đáp án đúng)' });
            }
            if (type === 'multi' && (!q.correctList || q.correctList.length < 2)) {
                warnings.push({ index: i, msg: 'Câu ' + num + ': Câu nhiều đáp án cần ít nhất 2 dấu *' });
            }
            if (type === 'truefalse' && q.correctTF) {
                var undecided = q.correctTF.filter(function(v) { return v === undefined || v === null; }).length;
                if (undecided > 0) {
                    warnings.push({ index: i, msg: 'Câu ' + num + ': ' + undecided + ' phát biểu chưa có (đúng)/(sai)/(Đ)/(S)' });
                }
            }
            if (type === 'shortanswer' && !q.correctAnswer) {
                warnings.push({ index: i, msg: 'Câu ' + num + ': Câu trả lời ngắn chưa có đáp án — cần nhập trước khi lưu' });
            }
        });
        // Preview: rút gọn options (bỏ base64 dài để giảm payload)
        var preview = parsed.map(function(q, i) {
            return {
                index: i,
                type: q.type || 'single',
                questionPreview: stripHtmlTags(q.question).substring(0, 120),
                optionCount: q.options ? q.options.length : 0,
                correct: q.correct,
                correctList: q.correctList,
                correctTF: q.correctTF,
                hasImage: /data:image\//i.test(q.question + (q.options || []).join(''))
            };
        });
        res.json({ success: true, count: parsed.length, preview: preview, warnings: warnings });
    }).catch(function(err) {
        res.json({ success: false, error: 'Không thể đọc file Word: ' + err.message });
    });
});

// Import câu hỏi từ file Word
app.post('/api/import-word', docxUpload.single('file'), async (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền import câu hỏi' });
    }
    
    console.log(`📤 Import Word: ${req.file ? req.file.originalname : 'không có file'}, Size: ${req.file ? req.file.size : 0} bytes`);
    
    if (!req.file || req.file.size === 0) {
        return res.json({ success: false, error: 'Không nhận được file' });
    }
    
    mammothToHtml(req.file.buffer).then(function(result) {
        var html = result.value;
        console.log('[INFO] Mammoth HTML (200 chars): ' + html.substring(0, 200));
        var warnings = [];
        var parsedQuestions = dropUnansweredShortAnswers(parseQuestionsFromHtml(html), warnings);

        if (parsedQuestions.length === 0) {
            return res.json({ success: false, error: 'Không tìm thấy câu hỏi nào. Kiểm tra lại định dạng file.', warnings: warnings });
        }

        parsedQuestions.forEach(function(q, i) {
            var num = i + 1;
            var type = q.type || 'single';
            if (!q.question || q.question.trim() === '') {
                warnings.push('Câu ' + num + ': Thiếu nội dung câu hỏi');
            }
            if (type !== 'shortanswer' && (!q.options || q.options.length < 2)) {
                warnings.push('Câu ' + num + ': Chỉ có ' + (q.options ? q.options.length : 0) + ' đáp án (cần ít nhất 2)');
            }
            if (type === 'multi' && (!q.correctList || q.correctList.length < 2)) {
                warnings.push('Câu ' + num + ': Câu [MULTI] cần ít nhất 2 dấu *');
            }
            if (type === 'truefalse' && q.correctTF) {
                var undecided = q.correctTF.filter(function(v) { return v === undefined || v === null; }).length;
                if (undecided > 0) {
                    warnings.push('Câu ' + num + ': ' + undecided + ' phát biểu chưa có (đúng)/(sai)');
                }
            }
        });

        questions = questions.concat(parsedQuestions);
        saveQuestions();
        io.emit('questionsUpdated', questions.length);
        res.json({ success: true, imported: parsedQuestions.length, total: questions.length, warnings: warnings });
    }).catch(function(err) {
        console.error('Lỗi đọc file Word:', err);
        res.json({ success: false, error: 'Không thể đọc file Word: ' + err.message });
    });
});

// ===========================================================================
// NHẬP ĐỀ THI TỪ WORD / ẢNH  (xem trước -> giáo viên sửa -> xác nhận mới lưu)
// ===========================================================================
// Tái sử dụng mammothToHtml() và parseQuestionsFromHtml() ở trên.
// Ảnh được tách thành token [[IMG:n]]; dữ liệu ảnh giữ trong phiên (RAM, có TTL).
// KHÔNG tự bịa đáp án: câu thiếu đáp án được đánh dấu needsReview.

var IMG_TOKEN_RE = /\[\[IMG:(\d+)\]\]/g;

// Tách mọi <img src="data:..."> trong câu hỏi/đáp án thành token [[IMG:n]]
function extractImagesToTokens(questions) {
    var pool = {};   // token -> dataUri
    var order = [];  // thứ tự token để tái sử dụng ảnh trùng
    var seq = 0;

    function walk(html) {
        if (!html || typeof html !== 'string') return html;
        return html.replace(/<img\b[^>]*?src\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, function (full, _q, dq, sq) {
            var src = dq !== undefined ? dq : sq;
            if (!/^data:image\//i.test(src)) return '';
            for (var i = 0; i < order.length; i++) {
                if (pool[order[i]] === src) return '[[IMG:' + order[i] + ']]';
            }
            var token = String(seq++);
            pool[token] = src;
            order.push(token);
            return '[[IMG:' + token + ']]';
        });
    }

    questions.forEach(function (q) {
        q.question = walk(q.question);
        if (q.options) q.options = q.options.map(walk);
    });
    return pool;
}

// Thay token [[IMG:n]] bằng lại ảnh gốc từ pool của phiên (không tin dữ liệu client)
function expandTokens(html, pool) {
    if (!html || typeof html !== 'string') return html || '';
    return html.replace(IMG_TOKEN_RE, function (m, n) {
        return Object.prototype.hasOwnProperty.call(pool, n) ? '<img src="' + pool[n] + '" />' : '';
    });
}

// Chuẩn hoá 1 câu hỏi do client gửi về (đã qua chỉnh sửa ở bản xem trước)
function normalizeEditedQuestion(raw, qNum) {
    if (!raw || typeof raw !== 'object') return { error: 'Câu ' + qNum + ': dữ liệu không hợp lệ' };
    var type = raw.type;
    if (type !== 'single' && type !== 'multi' && type !== 'truefalse' && type !== 'shortanswer') {
        return { error: 'Câu ' + qNum + ': loại câu hỏi không hợp lệ' };
    }
    var out = {
        type: type,
        question: String(raw.question == null ? '' : raw.question),
        options: Array.isArray(raw.options) ? raw.options.map(function (o) { return String(o == null ? '' : o); }) : [],
        correct: 0,
        correctList: null,
        correctTF: null,
        correctAnswer: null,
        image: null,
        points: normalizePoints(raw.points)
    };
    if (type === 'single') {
        out.correct = (typeof raw.correct === 'number') ? raw.correct : -1;
    } else if (type === 'multi') {
        out.correctList = Array.isArray(raw.correctList)
            ? raw.correctList.filter(function (v) { return typeof v === 'number'; })
            : [];
        out.correct = out.correctList.length ? out.correctList[0] : -1;
    } else if (type === 'truefalse') {
        out.correctTF = Array.isArray(raw.correctTF)
            ? raw.correctTF.map(function (v) { return v === true ? true : (v === false ? false : null); })
            : [];
    } else {
        out.options = [];
        out.correctAnswer = shortAnswer.normalize(raw.correctAnswer);
    }
    return { question: out };
}

// ---- Bước 1: phân tích file Word -> trả về bản xem trước để giáo viên sửa ----
app.post('/api/import/preview', docxUpload.single('file'), function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền' });

    var file = req.file;
    if (!file) {
        return res.json({ success: false, error: 'Chưa chọn file Word nào.' });
    }

    var check = fileValidate.validateUpload(file);
    if (!check.ok) {
        return res.json({ success: false, error: check.error });
    }
    if (check.kind !== 'docx') {
        return res.json({ success: false, error: 'Chỉ nhận file Word (.docx).' });
    }

    mammothToHtml(file.buffer).then(function (result) {
        var parseOpts = { trackReview: true };
        var questions = parseQuestionsFromHtml(result.value, parseOpts);
        var answerTableReport = parseOpts.answerTableReport || null;
        var completeness = analyzeImportCompleteness(questions);
        if (completeness.warnings.length > 1) {
            console.warn('[IMPORT] ' + file.originalname + ': ' + completeness.warnings.join(' '));
        }

        // Tách ảnh nhúng trong Word thành token cho payload xác nhận gọn nhẹ.
        var pool = extractImagesToTokens(questions);
        var sessionId = importSessions.create({ pool: pool });
        var needsReview = questions.filter(function (q) { return q.needsReview; }).length;

        res.json({
            success: true,
            sessionId: sessionId,
            count: questions.length,
            needsReview: needsReview,
            warnings: [],
            answerTables: answerTableReport,
            completeness: completeness,
            imagePool: pool,
            source: {
                docx: file.originalname,
                images: []
            },
            questions: questions.map(function (q, idx) {
                var detected = !!q.answerDetected;
                return {
                    index: idx,
                    type: q.type || 'single',
                    question: q.question || '',
                    options: q.options || [],
                    // Chưa xác định được đáp án -> null (KHÔNG tự gán đáp án A)
                    correct: (detected && typeof q.correct === 'number' && q.correct >= 0) ? q.correct : null,
                    correctList: (q.correctList && q.correctList.length) ? q.correctList : null,
                    correctTF: q.correctTF || null,
                    correctAnswer: q.type === 'shortanswer' ? (q.correctAnswer || null) : null,
                    points: normalizePoints(q.points),
                    needsReview: !!q.needsReview,
                    reviewReasons: q.reviewReasons || [],
                    answerDetected: detected,
                    // Thong tin phan/cau de giao vien doi chieu bang dap an da ghep.
                    importSection: q.importMeta ? q.importMeta.sectionLabel : null,
                    importNumber: q.importMeta ? q.importMeta.number : null,
                    answerSource: q.answerSource || null,
                    answerTableNotes: q.answerTableNotes || null,
                    answerWarnings: q.answerWarnings || null
                };
            })
        });
    }).catch(function (err) {
        console.error('Lỗi đọc file khi xem trước:', err);
        res.json({
            success: false,
            error: 'Không thể đọc file: ' + (err && err.message ? err.message : 'lỗi không xác định')
        });
    });
});

// ---- Bước 2: lưu SAU KHI giáo viên xác nhận (không lưu trước đó) ----
app.post('/api/import/confirm', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền' });

    var body = req.body || {};
    var session = importSessions.get(body.sessionId);
    if (!session) {
        return res.json({ success: false, error: 'Phiên nhập đề đã hết hạn hoặc không tồn tại. Vui lòng chọn lại file.' });
    }
    var pool = session.pool || {};

    var incoming = Array.isArray(body.questions) ? body.questions : [];
    if (incoming.length === 0) {
        return res.json({ success: false, error: 'Không có câu hỏi nào để lưu.' });
    }

    var saved = [];
    var skipped = [];
    var excluded = 0;

    incoming.forEach(function (raw, i) {
        var num = i + 1;
        if (raw && raw.include === false) { excluded++; return; }

        var norm = normalizeEditedQuestion(raw, num);
        if (norm.error) { skipped.push({ index: i, reason: norm.error }); return; }
        var q = norm.question;

        // Thay token ảnh -> data URI gốc (chỉ lấy từ pool của phiên)
        q.question = expandTokens(q.question, pool);
        q.options = q.options.map(function (o) { return expandTokens(o, pool); });

        // Làm sạch HTML
        q.question = sanitizeHtml(q.question);
        q.options = q.options.map(function (o) { return sanitizeHtml(o); });

        // Đúng/Sai: bắt buộc mọi phát biểu đã được chọn (không lưu dữ liệu bỏ trống)
        if (q.type === 'truefalse') {
            var undecided = q.correctTF.filter(function (v) { return v !== true && v !== false; }).length;
            if (undecided > 0) {
                skipped.push({ index: i, reason: 'Câu ' + num + ': còn ' + undecided + ' phát biểu chưa chọn Đúng/Sai' });
                return;
            }
        }

        var errs = [];
        var normalized = validateAndNormalizeQuestion(q, num, errs);
        if (!normalized) { skipped.push({ index: i, reason: errs.join('; ') }); return; }
        saved.push(normalized);
    });

    if (saved.length === 0) {
        return res.json({
            success: false,
            error: 'Không có câu hỏi hợp lệ để lưu. Vui lòng kiểm tra các câu bị đánh dấu.',
            skipped: skipped
        });
    }

    var destination = (body.destination === 'current') ? 'current' : 'new';

    // Đối chiếu số câu nhận được với số câu thực sự lưu + bỏ qua (kèm lý do).
    var saveCounts = {
        received: incoming.length,
        savedCount: saved.length,
        skippedCount: skipped.length,
        excludedCount: excluded,
        complete: false
    };
    saveCounts.complete = (saveCounts.received ===
        saveCounts.savedCount + saveCounts.skippedCount + saveCounts.excludedCount);
    if (!saveCounts.complete) {
        console.warn('[IMPORT] Số câu nhận được (' + saveCounts.received + ') khác số câu đã xử lý (' +
            (saveCounts.savedCount + saveCounts.skippedCount + saveCounts.excludedCount) + ').');
    }

    if (destination === 'current') {
        questions = questions.concat(saved);
        saveQuestions();
        io.emit('questionsUpdated', questions.length);
        importSessions.remove(body.sessionId);
        return res.json(Object.assign({
            success: true, destination: 'current',
            saved: saved.length, skipped: skipped, total: questions.length
        }, saveCounts));
    }

    var name = String(body.examName == null ? '' : body.examName).replace(/[<>]/g, '').trim();
    if (!name) {
        return res.json({ success: false, error: 'Vui lòng nhập tên bài kiểm tra mới.', skipped: skipped });
    }

    var newExamId = 'exam_' + Date.now();
    var examData = {
        id: newExamId,
        name: name.slice(0, 40),
        questions: saved,
        createdAt: new Date().toISOString()
    };
    DATA.writeJson(path.join(__dirname, 'data', 'exams', newExamId + '.json'), examData);
    importSessions.remove(body.sessionId);

    res.json(Object.assign({
        success: true, destination: 'new',
        examId: newExamId, examName: examData.name,
        saved: saved.length, skipped: skipped, total: saved.length
    }, saveCounts));
});

// ========== HTML SANITIZER ==========
// sanitizeHtml duoc tach sang lib/question-content.js de test rieng. Cho phep
// anh cu (data:image/) va anh tai len moi (/api/assets/<id>).

// ========== OMML -> LATEX CONVERTER ==========
// Escape ky tu dac biet cua LaTeX trong phan van ban cua cong thuc.
// Chu co dau (vi du "nghiem") phai nam trong \text{} de KaTeX hien dung dau.
function ommlTextToLatex(text) {
    var s = String(text == null ? '' : text);
    if (!s) return '';
    var hasNonAscii = /[^\x00-\x7F]/.test(s);
    // Chu co dau (Latin mo rong / tieng Viet) phai vao \text{}; ky hieu Hy Lap
    // va toan hoc (α, β, Δ, ±, ∑...) thi giu nguyen trong math mode.
    var hasTextLetters = /[\u00C0-\u024F\u1E00-\u1EFF]/.test(s);
    if (hasNonAscii && hasTextLetters) {
        return '\\text{' + s.replace(/[\\{}%#$&_]/g, '\\$&') + '}';
    }
    return s
        .replace(/\\/g, '\\backslash ')
        .replace(/([{}%#$&_])/g, '\\$1')
        .replace(/\^/g, '\\^{}')
        .replace(/~/g, '\\~{}');
}

function ommlDelimiterToLatex(chr) {
    var map = { '{': '\\{', '}': '\\}', '<': '\\langle', '>': '\\rangle' };
    return map[chr] || chr;
}

function ommlNodeToLatex(node) {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    var name = (node.name || '').replace('m:', '');
    var children = node.elements || [];
    function child(n) { return children.find(function(c){ return (c.name||'').replace('m:','') === n; }); }
    function childrenOf(n) { var c = child(n); return c ? (c.elements || []) : []; }
    function latex(nodes) { return (nodes||[]).map(ommlNodeToLatex).join(''); }
    function latexChild(n) { return latex(childrenOf(n)); }
    switch(name) {
        case 'oMath': case 'oMathPara': return latex(children);
        case 'f': return '\\frac{' + latexChild('num') + '}{' + latexChild('den') + '}';
        case 'sSup': return latexChild('e') + '^{' + latexChild('sup') + '}';
        case 'sSub': return latexChild('e') + '_{' + latexChild('sub') + '}';
        case 'sSubSup': return latexChild('e') + '_{' + latexChild('sub') + '}^{' + latexChild('sup') + '}';
        case 'rad': {
            var pr = child('radPr');
            var hideEl = pr && (pr.elements||[]).find(function(c){ return (c.name||'').replace('m:','') === 'degHide'; });
            var hideAttr = hideEl && hideEl.attributes ? (hideEl.attributes['m:val'] || hideEl.attributes.val) : '';
            var hide = hideEl && hideAttr !== '0' && hideAttr !== 'false';
            var deg = latexChild('deg'); var e = latexChild('e');
            if (hide || !deg.trim()) return '\\sqrt{' + e + '}';
            return '\\sqrt[' + deg + ']{' + e + '}';
        }
        case 'nary': {
            var nPr = child('naryPr');
            var chrEl = nPr && (nPr.elements||[]).find(function(c){ return (c.name||'').replace('m:','') === 'chr'; });
            var chr = chrEl && chrEl.attributes && (chrEl.attributes['m:val'] || chrEl.attributes.val);
            var symMap = {
                '\u222B': '\\int', '\u222C': '\\iint', '\u222D': '\\iiint',
                '\u2211': '\\sum', '\u220F': '\\prod', '\u2210': '\\coprod',
                '\u222E': '\\oint', '\u22C3': '\\bigcup', '\u22C2': '\\bigcap'
            };
            var sym = symMap[chr] || '\\int';
            var sub2 = latexChild('sub'); var sup2 = latexChild('sup'); var e2 = latexChild('e');
            return sym + (sub2 ? '_{'+sub2+'}' : '') + (sup2 ? '^{'+sup2+'}' : '') + ' ' + e2;
        }
        case 'd': {
            var dPr = child('dPr');
            function getDPrChr(tag, def) {
                var el = dPr && (dPr.elements||[]).find(function(c){ return (c.name||'').replace('m:','') === tag; });
                return el && el.attributes ? (el.attributes['m:val'] || el.attributes.val || def) : def;
            }
            var beg = getDPrChr('begChr','('); var end = getDPrChr('endChr',')');
            var inner = children.filter(function(c){ return (c.name||'').replace('m:','') === 'e'; })
                .map(function(c){ return latex(c.elements||[]); }).join(', ');
            if (!beg && !end) return inner;
            // \left/\right can '.' khi mot ben khong co dau ngoac.
            return '\\left' + (beg ? ommlDelimiterToLatex(beg) : '.') +
                inner + '\\right' + (end ? ommlDelimiterToLatex(end) : '.');
        }
        case 'limLow': return latexChild('e') + '_{' + latexChild('lim') + '}';
        case 'limUpp': return latexChild('e') + '^{' + latexChild('lim') + '}';
        case 'm': {
            var rows = children.filter(function(c){ return (c.name||'').replace('m:','') === 'mr'; });
            return '\\begin{pmatrix}' + rows.map(function(row){
                return (row.elements||[]).filter(function(c){ return (c.name||'').replace('m:','') === 'e'; })
                    .map(function(c){ return latex(c.elements||[]); }).join(' & ');
            }).join(' \\\\ ') + '\\end{pmatrix}';
        }
        case 'func': return latexChild('fName') + ' ' + latexChild('e');
        case 'acc': {
            var aPr = child('accPr');
            var aChrEl = aPr && (aPr.elements||[]).find(function(c){ return (c.name||'').replace('m:','') === 'chr'; });
            var aChr = aChrEl && aChrEl.attributes ? (aChrEl.attributes['m:val'] || aChrEl.attributes.val) : '';
            var accMap = {'\u0302':'\\hat','\u0303':'\\tilde','\u0304':'\\bar','\u20D7':'\\vec','\u0307':'\\dot','\u0308':'\\ddot'};
            return (accMap[aChr]||'\\hat') + '{' + latexChild('e') + '}';
        }
        case 'bar': {
            var bPr = child('barPr');
            var posEl = bPr && (bPr.elements||[]).find(function(c){ return (c.name||'').replace('m:','') === 'pos'; });
            var pos2 = posEl && posEl.attributes ? (posEl.attributes['m:val'] || posEl.attributes.val) : 'top';
            return pos2 === 'bot' ? '\\underline{' + latexChild('e') + '}' : '\\overline{' + latexChild('e') + '}';
        }
        case 'eqArr': {
            var eqs = children.filter(function(c){ return (c.name||'').replace('m:','') === 'e'; });
            return '\\begin{aligned}' + eqs.map(function(c){ return latex(c.elements||[]); }).join(' \\\\ ') + '\\end{aligned}';
        }
        case 'r': case 'e': case 'num': case 'den': case 'sup': case 'sub':
        case 'deg': case 'lim': case 'fName': return latex(children);
        case 't': return ommlTextToLatex(children.map(function(c){ return c.text || ''; }).join(''));
        case 'rPr': case 'fPr': case 'sSupPr': case 'sSubPr': case 'sSubSupPr':
        case 'radPr': case 'naryPr': case 'dPr': case 'mPr': case 'mrPr':
        case 'limLowPr': case 'limUppPr': case 'funcPr': case 'accPr':
        case 'ctrlPr': case 'eqArrPr': case 'boxPr': case 'barPr': return '';
        default: return latex(children);
    }
}

function ommlStringToLatex(ommlStr) {
    try {
        var obj = xmljs.xml2js(ommlStr, { compact: false, ignoreDeclaration: true });
        var root = obj.elements && obj.elements[0];
        return ommlNodeToLatex(root);
    } catch(e) { return null; }
}

// Pre-process docx buffer: thay OMML bằng placeholder text để mammoth giữ lại vị trí
function preprocessDocxMath(buffer) {
    return JSZip.loadAsync(buffer).then(function(zip) {
        var docFile = zip.file('word/document.xml');
        if (!docFile) return { buffer: buffer, mathMap: {} };
        return docFile.async('string').then(function(xml) {
            if (xml.indexOf('m:oMath') === -1) return { buffer: buffer, mathMap: {} };
            var mathMap = {};
            var counter = 0;
            var result = '';
            var i = 0;
            while (i < xml.length) {
                var startTag = xml.indexOf('<m:oMath', i);
                if (startTag === -1) { result += xml.slice(i); break; }
                result += xml.slice(i, startTag);
                var tagEnd = xml.indexOf('>', startTag);
                var tagName = xml.slice(startTag + 1, tagEnd).split(/[\s>]/)[0];
                var closeTag = '</' + tagName + '>';
                var depth = 1, pos = tagEnd + 1;
                while (depth > 0 && pos < xml.length) {
                    var nextOpen  = xml.indexOf('<' + tagName, pos);
                    var nextClose = xml.indexOf(closeTag, pos);
                    if (nextClose === -1) break;
                    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 1; }
                    else { depth--; pos = (depth === 0) ? nextClose + closeTag.length : nextClose + 1; }
                }
                var ommlStr = xml.slice(startTag, pos);
                var latexStr = ommlStringToLatex(ommlStr);
                if (latexStr !== null) {
                    // oMathPara = cong thuc doc lap; oMath = cong thuc noi dong.
                    var wrapped = (tagName === 'm:oMathPara')
                        ? '\\[' + latexStr + '\\]'
                        : '\\(' + latexStr + '\\)';
                    var placeholder = 'MATHPLACEHOLDER' + counter + 'END';
                    mathMap[placeholder] = wrapped;
                    result += '<w:r><w:t xml:space="preserve"> ' + placeholder + ' </w:t></w:r>';
                    counter++;
                } else {
                    result += ommlStr;
                }
                i = pos;
            }
            zip.file('word/document.xml', result);
            return zip.generateAsync({ type: 'nodebuffer' }).then(function(newBuf) {
                return { buffer: newBuf, mathMap: mathMap };
            });
        });
    });
}

// ========== MAMMOTH HTML HELPER ==========
function mammothToHtml(buffer) {
    return preprocessDocxMath(buffer).then(function(data) {
        return mammoth.convertToHtml(
            { buffer: data.buffer },
            {
                styleMap: [
                    "p[style-name='Code'] => pre",
                    // Giu lai thong tin GACH CHAN cua Word (mammoth mac dinh bo qua).
                    // Nhieu de thi danh dau dap an dung bang cach gach chan chu cai
                    // dap an -> can thong tin nay de nhan dien dung dap an.
                    "u => u"
                ],
                convertImage: mammoth.images.imgElement(function(image) {
                    return image.read('base64').then(function(imageBase64) {
                        return { src: 'data:' + image.contentType + ';base64,' + imageBase64 };
                    });
                })
            }
        ).then(function(result) {
            var html = result.value;
            Object.keys(data.mathMap).forEach(function(placeholder) {
                // Escape HTML truoc khi chen: LaTeX co the chua "<", ">" hoac "&".
                var latex = data.mathMap[placeholder]
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                html = html.split(placeholder).join(latex);
            });
            // Escape HTML inside <pre> so code is displayed as text, not rendered as HTML
            html = html.replace(/<pre>([\s\S]*?)<\/pre>/gi, function(match, inner) {
                var escaped = inner
                    .replace(/&amp;/g, '&')   // decode any double-encoding first
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/<br\s*\/?>/gi, '\n');  // convert <br> back to newlines
                return '<pre>' + escaped + '</pre>';
            });
            return { value: html, messages: result.messages };
        });
    });
}

// ========== PARSE CÂU HỎI TỪ HTML (mammoth output) ==========
function stripHtmlTags(html) {
    return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function removeCorrectMarkers(html) {
    return html.replace(/\*|\[x\]|\[X\]/g, '')
        .replace(/\(đúng\)|\(dung\)/gi, '')
        // Bo the gach chan: gach chan trong 1 dong dap an duoc coi la dau hieu
        // "dap an dung" (giong dau "*"), nen khong giu lai trong noi dung cau hoi.
        .replace(/<\/?u\b[^>]*>/gi, '')
        .trim();
}

// Dong dap an co bi GACH CHAN khong? (mammoth xuat the <u> khi bat styleMap "u => u")
var UNDERLINE_MARKER_RX = /<u\b[^>]*>[\s\S]*?<\/u>/i;

function hasUnderlineMarker(html) {
    return UNDERLINE_MARKER_RX.test(String(html || ''));
}

// Regex nhận dạng marker "đúng" cho truefalse: (đúng) (dung) (Đ) (D) (d) (đ) (T) (t) (Y) (y)
var TF_TRUE_REGEX = /\(đúng\)|\(dung\)|\(Đ\)|\(đ\)|\(D\)|\(d\)|\(T\)|\(t\)|\(Y\)|\(y\)/i;
// Regex nhận dạng marker "sai" cho truefalse: (sai) (S) (s) (F) (f) (N) (n)
var TF_FALSE_REGEX = /\(sai\)|\(S\)|\(s\)|\(F\)|\(f\)|\(N\)|\(n\)/i;
// Regex xóa tất cả TF markers khỏi HTML
var TF_ALL_MARKERS = /\(đúng\)|\(dung\)|\(Đ\)|\(đ\)|\(D\)|\(d\)|\(T\)|\(t\)|\(Y\)|\(y\)|\(sai\)|\(S\)|\(s\)|\(F\)|\(f\)|\(N\)|\(n\)/gi;

function removeTFMarkers(html) {
    return html.replace(TF_ALL_MARKERS, '').trim();
}

// ---------- Bo tien to ("Câu 80.", "D.") trong HTML cua Word ----------
// Word hay IN DAM / GACH CHAN / to mau cho chinh tien to, nen HTML co dang
//   "<strong>Câu 80.</strong> noi dung..."
//   "<u>D</u><strong>.</strong> noi dung..."
//   "<strong>D. noi dung...</strong>"
// Vi vay khong the dung regex tren chuoi HTML: phai tim tien to tren VAN BAN
// THUAN (bo qua the) roi cat dung vi tri tuong ung trong HTML. Neu khong lam
// vay, "Câu 80." se bi giu lai trong noi dung cau hoi -> trong ban xem truoc
// trong nhu cau 71 bi "long" cau 80 (loi giao vien da bao).

// Ban do: moi ky tu cua van ban thuan -> vi tri tuong ung trong HTML
function mapHtmlText(html) {
    var chars = [];
    var i = 0;
    while (i < html.length) {
        var c = html.charAt(i);
        if (c === '<') {
            var e = html.indexOf('>', i);
            if (e === -1) break;
            i = e + 1;
            continue;
        }
        if (c === '&') {
            var ent = html.slice(i).match(/^&(amp|lt|gt|quot|apos|#39|nbsp);/i);
            if (ent) {
                var name = ent[1].toLowerCase();
                var ch = ' ';
                if (name === 'amp') ch = '&';
                else if (name === 'lt') ch = '<';
                else if (name === 'gt') ch = '>';
                else if (name === 'quot') ch = '"';
                else if (name !== 'nbsp') ch = "'";
                chars.push({ text: ch, start: i, end: i + ent[0].length });
                i += ent[0].length;
                continue;
            }
        }
        chars.push({ text: c, start: i, end: i + 1 });
        i++;
    }
    var text = '';
    for (var k = 0; k < chars.length; k++) text += chars[k].text;
    return { text: text, chars: chars, htmlLen: html.length };
}

var VOID_HTML_TAGS = { br: 1, img: 1, hr: 1, input: 1, wbr: 1, col: 1 };

// Can bang the: bo the dong le, tu dong dong cac the mo con lai.
// Dung sau khi cat tien to (the boc quanh tien to bi cat mat, the dong cua no
// con lai -> phai bo di).
function balanceHtml(html) {
    var out = '';
    var stack = [];
    var re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
    var last = 0;
    var m;
    while ((m = re.exec(html)) !== null) {
        out += html.slice(last, m.index);
        last = re.lastIndex;
        var name = m[2].toLowerCase();
        if (VOID_HTML_TAGS[name] || /\/$/.test(String(m[3] || ''))) { out += m[0]; continue; }
        if (m[1] !== '/') { stack.push(name); out += m[0]; continue; }
        var at = stack.lastIndexOf(name);
        if (at === -1) continue;               // the dong khong co the mo -> bo
        for (var k = stack.length - 1; k > at; k--) out += '</' + stack[k] + '>';
        out += '</' + name + '>';
        stack.length = at;
    }
    out += html.slice(last);
    for (var k2 = stack.length - 1; k2 >= 0; k2--) out += '</' + stack[k2] + '>';
    return out;
}

// Bo `n` ky tu dau tien cua van ban thuan (kem cac the boc quanh chung)
function cutHtmlPrefix(html, n) {
    if (n <= 0) return html;
    var map = mapHtmlText(html);
    if (map.chars.length < n) return '';
    return balanceHtml(html.slice(map.chars[n - 1].end));
}

function stripOptionPrefix(html) {
    // Bo the gach chan cua Word TRUOC khi bo "A." / "B)" vi gach chan trong 1
    // dong dap an duoc coi la dau hieu "dap an dung" (giong dau "*").
    var s = String(html).replace(/<\/?u\b[^>]*>/gi, '');
    var m = mapHtmlText(s).text.match(/^\s*([A-Za-z])[\.\)]\s*/);
    if (!m) return s.trim();
    return cutHtmlPrefix(s, m[0].length).trim();
}

function stripQuestionPrefix(html) {
    // Loai bo "Câu N:" / "N." o dau, ke ca khi bi in dam/gach chan
    var s = String(html);
    var m = mapHtmlText(s).text.match(/^\s*(Câu\s*\d+\s*[\.:]\s*|\d+\s*[\.:]\s*)/i);
    if (!m) return s.trim();
    return cutHtmlPrefix(s, m[0].length).trim();
}

// Bo cac the dinh dang "trang tri" cua Word (in dam/nghieng/gach chan/mau) khoi
// noi dung cau hoi & dap an: chung chi lam ban ban xem truoc (hien ra chu
// "<strong>") va khong mang thong tin cho de thi. Giu nguyen anh, khoi code,
// chi so tren/duoi va cac token [[IMG:n]] / MATHPLACEHOLDER.
var INLINE_FMT_TAG_RX = /<\/?(?:b|strong|i|em|u|span|font|mark)\b[^>]*>/gi;

function stripInlineFormatting(html) {
    return String(html == null ? '' : html)
        .replace(INLINE_FMT_TAG_RX, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

// Chuoi cac the MO dang bao quanh vi tri `pos` (de khi cat 1 dong thanh nhieu
// dap an, moi dap an van giu du the dinh dang cua no, ke ca the gach chan)
function openTagPrefixAt(html, pos) {
    var stack = [];
    var re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
    var m;
    while ((m = re.exec(html)) !== null) {
        if (m.index >= pos) break;
        var name = m[2].toLowerCase();
        if (VOID_HTML_TAGS[name] || /\/$/.test(String(m[3] || ''))) continue;
        if (m[1] !== '/') { stack.push(m[0]); continue; }
        for (var k = stack.length - 1; k >= 0; k--) {
            if (new RegExp('^<' + name + '\\b', 'i').test(stack[k])) { stack.length = k; break; }
        }
    }
    return stack.join('');
}

// Tach 1 doan chua NHIEU dap an cung dong. Nhieu file Word (de 2025) trinh bay
// 2 cot bang khoang trang nen 1 doan co ca A, B (hoac ca A, B, C, D):
//   "A. Campuchia      B. Mianma      C. Brunay      D. Malaixia"
//   "A. Cộng đồng ASEAN.B. Hiệp hội Đông Nam Á."
// Neu khong tach, ca dong bi coi la 1 dap an -> cau do bi danh dau "can kiem
// tra" va dap an dung co the bi gan sai cho (gach chan nam o B nhung lai tinh
// cho A). Tra ve null neu doan chi co 1 dap an.
function splitInlineOptions(paraHtml) {
    var map = mapHtmlText(paraHtml);
    var text = map.text;
    var rx = /(^|[\s\u00a0]|[\.\)])([A-Za-z])[\.\)]/g;
    var marks = [];
    var m;
    while ((m = rx.exec(text)) !== null) {
        var after = text.charAt(rx.lastIndex);
        if (after !== '' && !/[\s\u00a0]/.test(after)) continue;   // "A.abc" khong phai nhan dap an
        marks.push({ letter: m[2].toUpperCase(), pos: m.index + m[1].length });
    }
    if (marks.length < 2) return null;
    if (text.slice(0, marks[0].pos).trim() !== '') return null;    // doan phai bat dau bang nhan dap an

    // Chi lay chuoi nhan LIEN TIEP tang dan: A, B, C, D...
    var run = [marks[0]];
    var expect = marks[0].letter.charCodeAt(0) + 1;
    for (var k = 1; k < marks.length; k++) {
        if (marks[k].letter.charCodeAt(0) === expect) { run.push(marks[k]); expect++; }
    }
    if (run.length < 2) return null;

    var segs = [];
    for (var s2 = 0; s2 < run.length; s2++) {
        var fromChar = run[s2].pos;
        var toChar = (s2 + 1 < run.length) ? run[s2 + 1].pos : map.chars.length;
        var htmlStart = map.chars[fromChar].start;
        var htmlEnd = (toChar < map.chars.length) ? map.chars[toChar].start : map.htmlLen;
        segs.push({
            letter: run[s2].letter,
            html: openTagPrefixAt(paraHtml, htmlStart) + paraHtml.slice(htmlStart, htmlEnd)
        });
    }
    return segs;
}

function stripTypeTags(html) {
    return html.replace(/\[MULTI\]/gi, '')
               .replace(/\[TRẢ LỜI NGẮN\]/gi, '')
               .replace(/\[TRA LOI NGAN\]/gi, '')
               .replace(/\[SHORT\]/gi, '')
               .replace(/\[ĐÚNG\/SAI\]/gi, '')
               .replace(/\[DUNGSAI\]/gi, '')
               .replace(/\[DUNG\/SAI\]/gi, '')
               .trim();
}

function buildQuestionObj(type, question, options, correctAnswer, correctList, correctTF, opts, correctAnswerText) {
    opts = opts || {};
    var answerDetected;
    var shortAnswerText = type === 'shortanswer' ? shortAnswer.normalize(correctAnswerText) : null;
    if (type === 'multi') {
        answerDetected = !!(correctList && correctList.length > 0);
    } else if (type === 'truefalse') {
        answerDetected = !!(correctTF && correctTF.length > 0) &&
            correctTF.every(function (v) { return v === true || v === false; });
    } else if (type === 'shortanswer') {
        answerDetected = !!shortAnswerText;
    } else {
        answerDetected = correctAnswer >= 0;
    }

    var obj = {
        type: type,
        question: sanitizeHtml(stripInlineFormatting(question)),
        options: type === 'shortanswer' ? [] : options.map(function(o) { return sanitizeHtml(stripInlineFormatting(o)); }),
        correct: correctAnswer >= 0 ? correctAnswer : 0,
        correctList: type === 'multi' ? correctList : null,
        correctTF: type === 'truefalse' ? correctTF : null,
        correctAnswer: shortAnswerText,
        image: null
    };

    // Chế độ "nhập đề có xem trước": KHÔNG tự gán đáp án A khi chưa nhận diện được,
    // mà đánh dấu để giáo viên kiểm tra.
    if (opts.trackReview) {
        obj.answerDetected = answerDetected;
        if (!answerDetected && type === 'single') obj.correct = -1;
        obj.needsReview = false;
        obj.reviewReasons = [];
    }
    return obj;
}

function parseQuestionsFromHtml(html, opts) {
    opts = opts || {};
    var parsedQuestions = [];

    // Bang dap an o cuoi file: tach khoi HTML de khong thanh cau hoi, va
    // giu lai cau truc bang de ghep dap an sau khi phan tich xong cau hoi.
    var tableResult = answerTables.extract(html);
    html = tableResult.cleanedHtml;

    // Mammoth xuat cac doan dung style Heading thanh <h1>..<h6>. Neu chi tach
    // cau hoi theo <p> thi toan bo cau nam trong heading bi bo qua am tham
    // (de that "Su-Trac nghiem.docx": mat 33/120 cau vi chung o <h1>).
    html = html.replace(/<(\/?)h[1-6]\b[^>]*>/gi, '<$1p>');

    var paragraphs = [];

    // Merge <pre> blocks into the preceding <p> so code stays attached to its question/option
    // Split HTML into tokens: either a <pre>...</pre> block or a <p>...</p> block
    var tokens = [];
    var remaining = html;
    var preRe = /<pre>([\s\S]*?)<\/pre>/i;
    var pRe = /<p[^>]*>([\s\S]*?)<\/p>/i;
    while (remaining.length > 0) {
        var preIdx = remaining.search(/<pre>/i);
        var pIdx = remaining.search(/<p[^>]*>/i);
        if (preIdx === -1 && pIdx === -1) break;
        if (pIdx === -1 || (preIdx !== -1 && preIdx < pIdx)) {
            // next token is a <pre>
            var pm = remaining.match(/<pre>([\s\S]*?)<\/pre>/i);
            if (!pm) break;
            tokens.push({ type: 'pre', content: pm[1], raw: pm[0] });
            remaining = remaining.slice(remaining.indexOf(pm[0]) + pm[0].length);
        } else {
            // next token is a <p>
            var pm2 = remaining.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
            if (!pm2) break;
            tokens.push({ type: 'p', content: pm2[1], raw: pm2[0] });
            remaining = remaining.slice(remaining.indexOf(pm2[0]) + pm2[0].length);
        }
    }

    // Merge each <pre> into the previous <p> token
    var merged = [];
    for (var ti = 0; ti < tokens.length; ti++) {
        if (tokens[ti].type === 'pre') {
            if (merged.length > 0) {
                merged[merged.length - 1].content += '<pre>' + tokens[ti].content + '</pre>';
            }
            // else: orphan <pre> at start, skip
        } else {
            merged.push({ content: tokens[ti].content });
        }
    }

    for (var mi = 0; mi < merged.length; mi++) {
        // For <p> content: replace <br> with space for plain-text detection
        // but keep the full HTML (including any appended <pre>) for storage
        var inner = merged[mi].content.replace(/<br\s*\/?>/gi, ' ').trim();
        if (inner) paragraphs.push(merged[mi].content);
    }

    // Gom các dòng giữa [CODE] và [/CODE] thành <pre> block gắn vào paragraph trước đó
    var mergedParagraphs = [];
    var codeBuffer = [];
    var inCode = false;
    for (var pi = 0; pi < paragraphs.length; pi++) {
        var plainLine = stripHtmlTags(paragraphs[pi]).trim();
        if (plainLine === '[CODE]') {
            inCode = true;
            codeBuffer = [];
        } else if (plainLine === '[/CODE]') {
            inCode = false;
            var preBlock = '<pre>' + codeBuffer.join('\n') + '</pre>';
            if (mergedParagraphs.length > 0) {
                mergedParagraphs[mergedParagraphs.length - 1] += preBlock;
            } else {
                mergedParagraphs.push(preBlock);
            }
            codeBuffer = [];
        } else if (inCode) {
            // Dòng code: lấy plain text (strip tất cả tags kể cả <strong> từ Word bold), rồi escape HTML
            var codeLine = stripHtmlTags(paragraphs[pi])
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            codeBuffer.push(codeLine);
        } else {
            mergedParagraphs.push(paragraphs[pi]);
        }
    }
    paragraphs = mergedParagraphs;

    // Fallback nếu không có thẻ <p>
    if (paragraphs.length === 0) {
        return parseQuestionsFromText(html.replace(/<[^>]+>/g, '\n'), opts);
    }

    var currentQuestion = null;
    var currentOptions = [];
    var currentType = 'single';
    var correctAnswer = -1;
    var correctList = [];
    var correctTF = [];
    var tfMarkerSeen = false;
    var currentReasons = [];
    var currentShortAnswer = '';
    // Loai cau mac dinh theo "Phần" dang mo (de 2025: Phần II = câu đúng/sai)
    var sectionType = null;
    var sectionIndex = -1;
    var currentSection = { key: null, label: '', index: -1 };
    var currentQuestionNumber = null;

    // "Phần II. Câu trắc nghiệm đúng sai. ..." la TIÊU ĐỀ PHẦN, khong phai noi
    // dung cau hoi. Truoc day dong nay bi coi la "đoạn chưa nhận dạng được" =>
    // tao ly do "cần kiểm tra" gia cho cau dung ngay truoc no.
    var SECTION_RE = /^\s*(?:Phần|PHẦN|Phan)\s+[IVXLC0-9]+\s*(?:[\.:\-–—]|\s|$)/i;
    // Tieu de phan khong co "Phần": "CÁC CÂU HỎI TRẢ LỜI NGẮN", "TRẮC NGHIỆM TRẢ LỜI NGẮN"
    var SHORT_SECTION_RE = /^\s*(?:CÁC\s+)?(?:CÂU\s+HỎI\s+|TRẮC\s+NGHIỆM\s+)*TRẢ\s+LỜI\s+NGẮN\s*[\.:]?\s*$/i;

    function sectionTypeOf(text) {
        if (/trả\s+lời\s+ngắn/i.test(text)) return 'shortanswer';
        if (/trắc nghiệm\s+đúng\s*[-\/–—]?\s*sai/i.test(text)) return 'truefalse';
        if (/^\s*PHẦN\s+[IVXLC0-9]+\s*[\.:\-–—]?\s*(?:CÂU\s+)?(?:HỎI\s+)?ĐÚNG\s*[-\/–—]?\s*SAI/i.test(text)) return 'truefalse';
        if (/trắc nghiệm\s+nhiều phương án/i.test(text)) return 'single';
        return null;
    }

    // Đẩy câu hỏi đang dựng vào kết quả.
    // Chế độ xem trước (opts.trackReview): giữ cả câu thiếu đáp án/đáp án <2 và
    // gắn cờ "cần kiểm tra" thay vì âm thầm bỏ hoặc tự bịa đáp án.
    function pushCurrent() {
        if (currentQuestion === null) return;

        if (currentType === 'truefalse') {
            // Chuan hoa correctTF cho khop so dap an (khong de lo hong)
            var nTF = currentOptions.length;
            for (var t = 0; t < nTF; t++) {
                if (typeof correctTF[t] !== 'boolean') correctTF[t] = null;
            }
            correctTF.length = nTF;
            if (!tfMarkerSeen && nTF > 0) {
                for (var t2 = 0; t2 < nTF; t2++) correctTF[t2] = null;
                currentReasons.push('Chưa nhận ra phát biểu nào đúng/sai — giáo viên cần chọn.');
            }
        }

        var isShortAnswer = currentType === 'shortanswer';
        var enoughOptions = isShortAnswer || currentOptions.length >= 2;
        if (!opts.trackReview && !enoughOptions) return;

        var obj = buildQuestionObj(currentType, currentQuestion, currentOptions, correctAnswer, correctList, correctTF, opts, currentShortAnswer);
        obj.importMeta = {
            sectionKey: currentSection.key,
            sectionLabel: currentSection.label,
            sectionIndex: currentSection.index,
            sectionType: sectionType || currentType,
            number: currentQuestionNumber
        };

        if (opts.trackReview) {
            var reasons = currentReasons.slice();
            var qPlain = stripHtmlTags(obj.question).trim();
            var qHasImg = /<img\b/i.test(obj.question);
            if (qPlain === '' && qHasImg) {
                reasons.push('Câu hỏi chỉ có hình ảnh — cần bổ sung nội dung chữ.');
            } else if (qPlain === '') {
                reasons.push('Thiếu nội dung câu hỏi.');
            }
            if (!isShortAnswer && !enoughOptions) {
                reasons.push('Chỉ có ' + currentOptions.length + ' đáp án (cần ít nhất 2).');
            }
            if (isShortAnswer) {
                if (!obj.correctAnswer) reasons.push('Chưa có đáp án trả lời ngắn — giáo viên cần nhập.');
            } else if (!obj.answerDetected) {
                reasons.push('Chưa xác định được đáp án đúng — giáo viên cần chọn.');
            }
            obj.reviewReasons = reasons;
            obj.needsReview = reasons.length > 0;
        }
        parsedQuestions.push(obj);
    }

    // Ap 1 dong dap an (co the la 1 phan sau khi tach dong chua nhieu dap an)
    function applyOption(letterRaw, optParaHtml) {
        var optIndex = String(letterRaw).toUpperCase().charCodeAt(0) - 65;
        if (optIndex < 0 || optIndex > 25) return;
        var optPlain = stripHtmlTags(optParaHtml);
        var optHtml = stripOptionPrefix(optParaHtml).trim();

        if (currentType === 'single') {
            if (optPlain.indexOf('*') >= 0 || /\(đúng\)|\(dung\)/i.test(optPlain) || hasUnderlineMarker(optParaHtml)) {
                correctAnswer = optIndex;
            }
            optHtml = removeCorrectMarkers(optHtml);
        } else if (currentType === 'multi') {
            if (optPlain.indexOf('*') >= 0 || /\(đúng\)|\(dung\)/i.test(optPlain) || hasUnderlineMarker(optParaHtml)) {
                correctList.push(optIndex);
            }
            optHtml = removeCorrectMarkers(optHtml);
        } else if (currentType === 'truefalse') {
            // Gach chan duoi 1 phat bieu = phat bieu DUNG (cung quy uoc voi
            // gach chan chan duoi dap an o phan I cua de)
            var marked = hasUnderlineMarker(optParaHtml) || TF_TRUE_REGEX.test(optPlain);
            correctTF[optIndex] = marked;
            if (marked) tfMarkerSeen = true;
            optHtml = removeTFMarkers(optHtml);
        }

        while (currentOptions.length < optIndex) currentOptions.push('');
        // Khong de 1 dong dap an RONG ghi de len noi dung da co
        if (optHtml !== '' || !currentOptions[optIndex]) currentOptions[optIndex] = optHtml;
    }

    for (var i = 0; i < paragraphs.length; i++) {
        var paraHtml = paragraphs[i];
        var plainText = stripHtmlTags(paraHtml);

        // Dong ket thuc de thi, khong phai noi dung cau hoi
        if (/^(?:[-–—]+\s*)?HẾT\s*[\.\!\:]?\s*(?:[-–—]+)?$/i.test(plainText.trim())) continue;

        // Tieu de phan -> chot cau dang dung, doi loai cau mac dinh cho phan sau
        if (SECTION_RE.test(plainText) || SHORT_SECTION_RE.test(plainText)) {
            pushCurrent();
            currentQuestion = null;
            currentOptions = [];
            correctAnswer = -1;
            correctList = [];
            correctTF = [];
            tfMarkerSeen = false;
            currentReasons = [];
            currentShortAnswer = '';
            currentType = 'single';
            sectionType = sectionTypeOf(plainText);
            if (sectionType) currentType = sectionType;

            sectionIndex++;
            var secMatch = plainText.match(/(?:Phần|PHAN|Phan)\s+([IVXLC]+|\d+)/i);
            currentSection = {
                key: secMatch ? answerTables.sectionKey(secMatch[1]) : null,
                label: secMatch ? 'Phần ' + String(secMatch[1]).toUpperCase() : plainText.trim().slice(0, 40),
                index: sectionIndex
            };
            currentQuestionNumber = null;
            continue;
        }

        var questionMatch = plainText.match(/^(Câu\s*\d+[\.:]\s*|\d+[\.:]\s*)(.*)/i);
        if (questionMatch) {
            pushCurrent();
            var numMatch = questionMatch[1].match(/\d+/);
            currentQuestionNumber = numMatch ? parseInt(numMatch[0], 10) : null;
            currentType = sectionType || 'single';
            correctAnswer = -1;
            correctList = [];
            correctTF = [];
            tfMarkerSeen = false;
            currentOptions = [];
            currentReasons = [];
            currentShortAnswer = '';

            if (/\[MULTI\]/i.test(plainText)) {
                currentType = 'multi';
            } else if (/\[TRẢ LỜI NGẮN\]|\[TRA LOI NGAN\]|\[SHORT\]/i.test(plainText)) {
                currentType = 'shortanswer';
            } else if (/\[ĐÚNG\/SAI\]|\[DUNGSAI\]|\[DUNG\/SAI\]/i.test(plainText)) {
                currentType = 'truefalse';
            }

            // Lấy inner HTML của câu hỏi, bỏ prefix "Câu N:" và type tags
            currentQuestion = stripQuestionPrefix(stripTypeTags(paraHtml)).trim();
            continue;
        }

        // Dap an cua cau tra loi ngan: "Đáp án: 3", "Đáp án đúng: 2,5", "Kết quả: 4"
        if (currentType === 'shortanswer' && currentQuestion !== null) {
            var ansMatch = plainText.match(/^\s*\(?\s*(?:Đáp\s*án(?:\s*đúng)?|ĐA|Kết\s*quả|Answer)\s*[:：]\s*(.+?)\s*\)?\s*$/i);
            if (ansMatch) {
                var detected = shortAnswer.normalize(ansMatch[1]);
                if (detected) {
                    currentShortAnswer = detected;
                } else {
                    currentShortAnswer = '';
                    if (opts.trackReview) {
                        currentReasons.push('Đáp án trong file không hợp lệ: "' + String(ansMatch[1]).slice(0, 40) + '" — giáo viên cần nhập lại.');
                    }
                }
                continue;
            }
        }

        var optionMatch = plainText.match(/^([A-Za-z])[\.\)]\s*(.*)/);
        var optSegments = null;
        if (optionMatch && currentQuestion !== null) {
            // 1 doan co the chua nhieu dap an (A. ... B. ... C. ... D. ...)
            optSegments = splitInlineOptions(paraHtml) || [{ letter: optionMatch[1], html: paraHtml }];
        }
        if (optSegments) {
            for (var si = 0; si < optSegments.length; si++) {
                applyOption(optSegments[si].letter, optSegments[si].html);
            }
        } else if (currentQuestion !== null) {
            var tailHasImg = /<img\b/i.test(paraHtml);
            if (currentOptions.length === 0) {
                currentQuestion += ' ' + paraHtml;
            } else if (tailHasImg && plainText.trim() === '') {
                // Đoạn chỉ có hình ảnh nằm sau các đáp án -> gắn vào câu hỏi và đánh dấu vị trí
                currentQuestion += ' ' + paraHtml;
                if (opts.trackReview) {
                    currentReasons.push('Có hình ảnh nằm riêng — kiểm tra xem thuộc câu hỏi hay đáp án nào.');
                }
            } else if (opts.trackReview && plainText.trim() !== '') {
                // Đoạn văn bản không nhận dạng được -> đánh dấu, không tự đoán
                currentReasons.push('Đoạn chưa nhận dạng được: "' + plainText.trim().slice(0, 60) + '"');
            }
        }
    }

    pushCurrent();

    // Ghep dap an tu bang cuoi file vao cau hoi da phan tich.
    var tableReport = answerTables.apply(parsedQuestions, tableResult.tables);
    if (opts) {
        opts.answerTableReport = {
            tables: tableReport.tables,
            warnings: tableResult.warnings.concat(tableReport.warnings)
        };
    }

    return parsedQuestions;
}

// ========== KIỂM TRA TÍNH ĐẦY ĐỦ SAU KHI PHÂN TÍCH ==========
// Chỉ BÁO CÁO, không tự tạo câu giả để bù số lượng thiếu.
function analyzeImportCompleteness(questions) {
    var report = {
        detected: questions.length,
        numbers: [],
        missingNumbers: [],
        duplicateNumbers: [],
        emptyQuestions: [],
        missingOptions: [],
        unparsedContent: [],
        imageCount: 0,
        unresolvedImages: [],
        warnings: []
    };

    function labelOf(q, i) {
        var n = q.importMeta && q.importMeta.number;
        return (n === null || n === undefined) ? ('câu #' + (i + 1)) : ('Câu ' + n);
    }

    var groups = {};
    questions.forEach(function (q, i) {
        var meta = q.importMeta || {};
        var label = labelOf(q, i);
        var questionHtml = String(q.question || '');
        var options = Array.isArray(q.options) ? q.options : [];
        var type = q.type || 'single';

        report.numbers.push(meta.number === undefined ? null : meta.number);

        var plain = stripHtmlTags(questionHtml).trim();
        var hasImg = /<img\b/i.test(questionHtml);
        if (plain === '' && !hasImg) {
            report.emptyQuestions.push(label);
        }

        if (type === 'shortanswer') {
            if (!q.correctAnswer) report.missingOptions.push(label + ' (thiếu đáp án trả lời ngắn)');
        } else if (options.length < 2) {
            report.missingOptions.push(label + ' (chỉ có ' + options.length + ' phương án)');
        }

        (q.reviewReasons || []).forEach(function (r) {
            if (/chưa nhận dạng được/i.test(String(r))) {
                report.unparsedContent.push(label + ': ' + String(r));
            }
        });

        var allHtml = questionHtml + ' ' + options.join(' ');
        var imgs = allHtml.match(/<img\b[^>]*>/gi) || [];
        report.imageCount += imgs.length;
        imgs.forEach(function (tag) {
            var src = (tag.match(/\bsrc\s*=\s*["']?([^"'\s>]*)/i) || [])[1] || '';
            if (!/^(data:|https?:)/i.test(src)) {
                report.unresolvedImages.push(label + ' (' + (src ? src.slice(0, 40) : 'không có src') + ')');
            }
        });

        // Đánh số được kiểm tra theo từng phần (đề có thể đánh số lại từ 1 ở Phần II).
        var groupKey = String(meta.sectionIndex);
        if (!groups[groupKey]) groups[groupKey] = [];
        if (typeof meta.number === 'number') groups[groupKey].push(meta.number);
    });

    Object.keys(groups).forEach(function (key) {
        var nums = groups[key].slice().sort(function (a, b) { return a - b; });
        if (nums.length === 0) return;
        var seen = {};
        nums.forEach(function (n) {
            if (seen[n]) {
                if (report.duplicateNumbers.indexOf(n) === -1) report.duplicateNumbers.push(n);
            }
            seen[n] = true;
        });
        for (var n = nums[0]; n < nums[nums.length - 1]; n++) {
            if (!seen[n]) report.missingNumbers.push(n);
        }
    });

    report.warnings.push('Nhận diện được ' + report.detected + ' câu hỏi.');
    if (report.missingNumbers.length) {
        report.warnings.push('Thiếu số thứ tự câu: ' + report.missingNumbers.join(', ') + '.');
    }
    if (report.duplicateNumbers.length) {
        report.warnings.push('Số thứ tự câu bị trùng: ' + report.duplicateNumbers.join(', ') + '.');
    }
    if (report.emptyQuestions.length) {
        report.warnings.push('Câu không có nội dung: ' + report.emptyQuestions.join(', ') + '.');
    }
    if (report.missingOptions.length) {
        report.warnings.push('Câu thiếu phương án/đáp án: ' + report.missingOptions.join(', ') + '.');
    }
    if (report.unparsedContent.length) {
        report.warnings.push('Nội dung chưa phân tích được: ' + report.unparsedContent.length + ' đoạn (xem từng câu trong danh sách cần kiểm tra).');
    }
    if (report.unresolvedImages.length) {
        report.warnings.push('Hình ảnh chưa xử lý được: ' + report.unresolvedImages.join(', ') + '.');
    }
    return report;
}

// Câu trả lời ngắn do file Word không kèm đáp án thì KHÔNG lưu thẳng:
// giáo viên phải nhập đáp án ở bước xem trước (tránh câu chấm sai âm thầm).
function dropUnansweredShortAnswers(list, warnings) {
    return list.filter(function (q, i) {
        if ((q.type || 'single') === 'shortanswer' && !q.correctAnswer) {
            if (warnings) warnings.push('Câu ' + (i + 1) + ': Câu trả lời ngắn chưa có đáp án — đã bỏ qua (dùng "Nhập Word/Ảnh" để nhập đáp án trước khi lưu).');
            return false;
        }
        return true;
    });
}

// ========== VALIDATE CÂU HỎI (dùng chung) ==========
// normalizePoints nam trong lib/grading.js (co test rieng).
// Trong so diem cua 1 cau (mac dinh 1). Giu tuong thich nguoc: khong co
// `points` thi diem van duoc tinh nhu cu (moi cau trong so 1).
function validateAndNormalizeQuestion(q, qNum, errors) {
    if (!q.question || q.question.trim() === '') {
        errors.push('Câu ' + qNum + ': Thiếu nội dung câu hỏi');
        return null;
    }

    var type = q.type || 'single';
    var points = 1;
    if (q.points !== undefined && q.points !== null) {
        points = parsePointsInput(q.points);
        if (points === null) {
            errors.push('Câu ' + qNum + ': Điểm phải là số lớn hơn 0 và không quá 100');
            return null;
        }
    }

    if (type === 'shortanswer') {
        var answer = shortAnswer.normalize(q.correctAnswer);
        if (!answer) {
            errors.push('Câu ' + qNum + ': Đáp án trả lời ngắn không hợp lệ hoặc để trống');
            return null;
        }
        return {
            type: 'shortanswer',
            question: String(q.question).trim(),
            options: [],
            correct: 0,
            correctList: null,
            correctTF: null,
            correctAnswer: answer,
            image: q.image || null,
            points: points
        };
    }

    if (!q.options || !Array.isArray(q.options) || q.options.length < 2) {
        errors.push('Câu ' + qNum + ': Thiếu hoặc không đủ đáp án (cần ít nhất 2)');
        return null;
    }

    if (type === 'single') {
        if (typeof q.correct !== 'number' || q.correct < 0 || q.correct >= q.options.length) {
            errors.push('Câu ' + qNum + ': Đáp án đúng không hợp lệ');
            return null;
        }
        return {
            type: 'single',
            question: String(q.question).trim(),
            options: q.options.map(function(o) { return String(o).trim(); }),
            correct: q.correct,
            correctList: null,
            correctTF: null,
            image: q.image || null,
            points: points
        };
    }

    if (type === 'multi') {
        if (!Array.isArray(q.correctList) || q.correctList.length === 0) {
            errors.push('Câu ' + qNum + ': Loại nhiều đáp án cần có correctList');
            return null;
        }
        for (var i = 0; i < q.correctList.length; i++) {
            if (typeof q.correctList[i] !== 'number' || q.correctList[i] < 0 || q.correctList[i] >= q.options.length) {
                errors.push('Câu ' + qNum + ': correctList chứa chỉ số không hợp lệ');
                return null;
            }
        }
        return {
            type: 'multi',
            question: String(q.question).trim(),
            options: q.options.map(function(o) { return String(o).trim(); }),
            correct: q.correctList[0],
            correctList: q.correctList,
            correctTF: null,
            image: q.image || null,
            points: points
        };
    }

    if (type === 'truefalse') {
        if (!Array.isArray(q.correctTF) || q.correctTF.length !== q.options.length) {
            errors.push('Câu ' + qNum + ': Loại đúng/sai cần correctTF cùng độ dài options');
            return null;
        }
        return {
            type: 'truefalse',
            question: String(q.question).trim(),
            options: q.options.map(function(o) { return String(o).trim(); }),
            correct: 0,
            correctList: null,
            correctTF: q.correctTF,
            image: q.image || null,
            points: points
        };
    }

    errors.push('Câu ' + qNum + ': Loại câu hỏi không hợp lệ (' + type + ')');
    return null;
}

// Hàm parse câu hỏi từ text
function parseQuestionsFromText(text, opts) {
    opts = opts || {};
    var questions = [];
    var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
    
    var currentQuestion = null;
    var currentOptions = [];
    var correctAnswer = -1;

    function pushQ() {
        var detected = correctAnswer >= 0;
        var enough = currentOptions.length >= 2;
        var item = {
            question: currentQuestion,
            options: currentOptions,
            correct: detected ? correctAnswer : 0,
            image: null
        };
        if (opts.trackReview) {
            item.type = 'single';
            item.answerDetected = detected;
            if (!detected) item.correct = -1;
            var reasons = [];
            if (!enough) reasons.push('Chỉ có ' + currentOptions.length + ' đáp án (cần ít nhất 2).');
            if (!detected) reasons.push('Chưa xác định được đáp án đúng — giáo viên cần chọn.');
            item.reviewReasons = reasons;
            item.needsReview = reasons.length > 0;
        }
        questions.push(item);
    }
    
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        
        // Kiểm tra nếu là câu hỏi (bắt đầu bằng "Câu X:" hoặc "Câu X." hoặc số)
        var questionMatch = line.match(/^(Câu\s*\d+[\.:]\s*|^\d+[\.:]\s*)(.*)/i);
        
        if (questionMatch) {
            // Lưu câu hỏi trước đó
            if (currentQuestion && (currentOptions.length >= 2 || opts.trackReview)) {
                pushQ();
            }
            
            currentQuestion = questionMatch[2] || '';
            currentOptions = [];
            correctAnswer = -1;
            continue;
        }
        
        // Kiểm tra nếu là đáp án (A. B. C. D. hoặc A) B) C) D))
        var optionMatch = line.match(/^([A-Za-z])[\.\)]\s*(.*)/);
        
        if (optionMatch && currentQuestion) {
            var optionText = optionMatch[2];
            var optionIndex = optionMatch[1].toUpperCase().charCodeAt(0) - 65;
            
            // Kiểm tra đáp án đúng (có dấu * hoặc [x] hoặc (đúng))
            if (optionText.includes('*') || optionText.includes('[x]') || optionText.includes('[X]') || 
                optionText.toLowerCase().includes('(đúng)') || optionText.toLowerCase().includes('(dung)')) {
                correctAnswer = optionIndex;
                optionText = optionText.replace(/\*|\[x\]|\[X\]|\(đúng\)|\(dung\)/gi, '').trim();
            }
            
            // Đảm bảo đủ số option
            while (currentOptions.length < optionIndex) {
                currentOptions.push('');
            }
            currentOptions[optionIndex] = optionText;
        }
        // Nếu không match và đang có câu hỏi, có thể là phần tiếp của câu hỏi
        else if (currentQuestion && currentOptions.length === 0 && !line.match(/^[A-Za-z][\.\)]/)) {
            currentQuestion += ' ' + line;
        }
    }
    
    // Lưu câu hỏi cuối cùng
    if (currentQuestion && (currentOptions.length >= 2 || opts.trackReview)) {
        pushQ();
    }
    
    return questions;
}

// Socket.IO
io.on('connection', function(socket) {
    console.log('[CONNECT] Co nguoi ket noi:', socket.id);
    
    // Gửi socket ID cho client
    socket.emit('connected', { socketId: socket.id });
    
    // Nhận thông báo khi học sinh rời tab
    socket.on('tabLeave', function(data) {
        console.log('[WARN] Hoc sinh ' + data.name + ' (STT ' + data.stt + ') roi khoi trang lan ' + data.count);

        // Lưu vào student status (debounce để không ghi disk liên tục)
        if (studentStatus[data.stt]) {
            studentStatus[data.stt].tabLeaveCount = data.count;
            studentStatus[data.stt].lastTabLeave = data.time;
            _saveStudentStatusDebounced();
        }

        // Thông báo cho giáo viên (teacher dashboard)
        io.emit('studentTabLeave', {
            stt: data.stt,
            name: data.name,
            count: data.count,
            time: data.time
        });
    });

    // Nhận thông báo khi học sinh thoát fullscreen
    socket.on('fullscreenExit', function(data) {
        console.log('[WARN] Hoc sinh ' + data.name + ' (STT ' + data.stt + ') THOAT FULLSCREEN lan ' + data.count);

        if (studentStatus[data.stt]) {
            studentStatus[data.stt].fullscreenExitCount = data.count;
            studentStatus[data.stt].lastFullscreenExit = data.time;
            _saveStudentStatusDebounced();
        }

        io.emit('studentFullscreenExit', {
            stt: data.stt,
            name: data.name,
            count: data.count,
            time: data.time
        });
    });
    
    // Khi ngắt kết nối, hủy chọn học sinh nếu chưa hoàn thành
    socket.on('disconnect', function() {
        console.log('[DISCONNECT] Ngat ket noi:', socket.id);
        var stt = socketToStt[socket.id];
        if (stt && studentStatus[stt] && studentStatus[stt].selectedBy === socket.id && !studentStatus[stt].completed) {
            studentStatus[stt].selected = false;
            studentStatus[stt].selectedBy = null;
            saveStudentStatus();
            io.emit('studentStatusUpdated', { stt: stt, status: studentStatus[stt] });
        }
        delete socketToStt[socket.id];
    });
});

// Trả lỗi JSON gọn cho các lỗi upload (multer) thay vì trang HTML mặc định.
app.use(function (err, req, res, next) {
    if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT' ||
        err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'UNSUPPORTED_TYPE')) {
        var msg = err.code === 'UNSUPPORTED_TYPE'
            ? err.message
            : 'File quá lớn hoặc không hợp lệ.';
        return res.status(400).json({ success: false, error: msg });
    }
    next(err);
});

// Lấy địa chỉ IP
function getLocalIP() {
    var interfaces = os.networkInterfaces();
    var names = Object.keys(interfaces);
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var ifaceList = interfaces[name];
        for (var j = 0; j < ifaceList.length; j++) {
            var iface = ifaceList[j];
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// Hàm log đồng bộ
function safeLog(msg) {
    try {
        var fs = require('fs');
        fs.writeSync(1, msg + '\n');
    } catch(e) {
        console.log(msg);
    }
}

// Khởi động server
safeLog('');
safeLog('========================================');
safeLog('Dang khoi tao lop luu tru...');
safeLog('========================================');

// Nạp toàn bộ dữ liệu từ storage vào bộ nhớ (đồng bộ sau khi storage đã init)
function loadAllData() {
    try { loadClasses(); safeLog('[OK] loadClasses'); } catch(e) { safeLog('[LOI] loadClasses: ' + e.message); }

    try { loadCurrentSession(); safeLog('[OK] loadCurrentSession'); } catch(e) { safeLog('[LOI] loadCurrentSession: ' + e.message); }

    try { loadQuestions(); safeLog('[OK] loadQuestions'); } catch(e) { safeLog('[LOI] loadQuestions: ' + e.message); }

    try { loadStudents(); safeLog('[OK] loadStudents'); } catch(e) { safeLog('[LOI] loadStudents: ' + e.message); }

    try { loadStudentStatus(); safeLog('[OK] loadStudentStatus'); } catch(e) { safeLog('[LOI] loadStudentStatus: ' + e.message); }

    try { loadResults(); safeLog('[OK] loadResults'); } catch(e) { safeLog('[LOI] loadResults: ' + e.message); }

    try { loadReports(); safeLog('[OK] loadReports'); } catch(e) { safeLog('[LOI] loadReports: ' + e.message); }

    try { loadReviewLists(); safeLog('[OK] loadReviewLists'); } catch(e) { safeLog('[LOI] loadReviewLists: ' + e.message); }

    try { loadServerProgress(); safeLog('[OK] loadServerProgress'); } catch(e) { safeLog('[LOI] loadServerProgress: ' + e.message); }

    safeLog('');
    safeLog('========================================');
    safeLog('Hoan tat tai du lieu!');
    safeLog('========================================');
}

// Error handler cho server
server.on('error', function(err) {
    console.log('');
    console.log('LOI SERVER: ' + err.message);
    if (err.code === 'EADDRINUSE') {
        console.log('Port ' + PORT + ' dang duoc su dung boi ung dung khac!');
        console.log('Hay tat ung dung dang chay tren port nay hoac doi port khac.');
    }
    console.log('');
    process.exit(1);
});

// Global error handler
process.on('uncaughtException', function(err) {
    console.log('');
    safeLog('LOI KHONG XU LY DUOC:');
    safeLog('  ' + err.message);
    if (err.stack) {
        safeLog('  Stack: ' + err.stack.split('\n').slice(0, 3).join('\n  '));
    }
    safeLog('');
    process.exit(1);
});

// Hien thi thong tin khoi dong
function printStartupInfo() {
    var ip = getLocalIP();
    var hostname = os.hostname();

    safeLog('');
    safeLog('================================================================');
    safeLog('   TRAC NGHIEM (online) v' + APP_VERSION);
    safeLog('   Che do luu tru: ' + DATA.mode);
    safeLog('================================================================');
    safeLog('');
    safeLog('   LINK GIAO VIEN: /teacher   (can dang nhap)');
    safeLog('   LINK HOC SINH : /');
    safeLog('   LINK ON TAP  : /on-tap');
    safeLog('');
    safeLog('   (LAN) http://' + hostname + ':' + PORT);
    safeLog('   (LAN) http://' + ip + ':' + PORT);
    safeLog('================================================================');
    safeLog('');
}

function startListening() {
    server.listen(PORT, '0.0.0.0', function() {
        safeLog('Server da san sang tren port ' + PORT + '!');
        safeLog('');
    });
}

// Khoi tao storage (bat dong bo) roi moi nap du lieu + listen
DATA.init().then(function() {
    auth.init();
    loadAllData();
    printStartupInfo();
    safeLog('Dang khoi dong server...');
    startListening();
}).catch(function(err) {
    safeLog('[LOI] Khoi tao storage that bai: ' + (err && err.message));
    process.exit(1);
});

// Xu ly tat server: SIGINT (local) va SIGTERM (Render khi deploy/restart)
function shutdown(signal) {
    safeLog('');
    safeLog('Nhan tin hieu ' + signal + '. Dang tat server...');
    Promise.resolve(DATA.flush()).then(function() {
        server.close(function() {
            safeLog('Server da tat.');
            process.exit(0);
        });
        // Du phong: thoat sau 5s neu close bi treo
        setTimeout(function() { process.exit(0); }, 5000).unref();
    });
}

process.on('SIGINT', function() { shutdown('SIGINT'); });
process.on('SIGTERM', function() { shutdown('SIGTERM'); });
