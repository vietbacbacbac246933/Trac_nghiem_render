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
// OCR (trich xuat chu tu anh) + chuan hoa van ban OCR
var ocr = require('./lib/ocr');
var ocrParse = require('./lib/ocr-parse');

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

// Cấu hình multer để lưu file trong memory
var upload = multer({ storage: multer.memoryStorage() });

// Multer riêng cho tính năng "Nhập đề từ Word/Ảnh": có giới hạn dung lượng + lọc định dạng.
// KHÔNG đụng tới `upload` ở trên để không làm đổi hành vi các API cũ.
var importUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: fileValidate.FILE_LIMITS.maxDocxBytes,
        files: fileValidate.FILE_LIMITS.maxImageCount + 1,
        fields: 10
    },
    fileFilter: function (req, file, cb) {
        if (!fileValidate.detectKind(file.originalname, file.mimetype)) {
            var err = new Error('Định dạng không hỗ trợ: "' + (file.originalname || '') + '". Chỉ nhận .docx và file ảnh.');
            err.code = 'UNSUPPORTED_TYPE';
            return cb(err);
        }
        cb(null, true);
    }
});

// Bọc multer để luôn trả JSON lỗi gọn gàng (thay vì trang lỗi HTML mặc định)
function importUploadMiddleware(field, max) {
    var handler = importUpload.array(field, max);
    return function (req, res, next) {
        handler(req, res, function (err) {
            if (err) {
                var msg;
                if (err.code === 'LIMIT_FILE_SIZE') {
                    msg = 'File quá lớn. Tối đa ' + Math.round(fileValidate.FILE_LIMITS.maxDocxBytes / 1024 / 1024) + ' MB cho Word và ' +
                        Math.round(fileValidate.FILE_LIMITS.maxImageBytes / 1024 / 1024) + ' MB cho ảnh.';
                } else if (err.code === 'LIMIT_FILE_COUNT') {
                    msg = 'Quá nhiều file. Tối đa ' + (fileValidate.FILE_LIMITS.maxImageCount + 1) + ' file mỗi lần.';
                } else {
                    msg = err.message || 'Lỗi tải file lên.';
                }
                return res.status(400).json({ success: false, error: msg });
            }
            next();
        });
    };
}

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

// Chan truy cap truc tiep /teacher.html (express.static se bo qua route /teacher)
app.use(function(req, res, next) {
    if (req.path === '/teacher.html' && !isTeacher(req)) {
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
        } else if (/\[ĐÚNG\/SAI\]|\[DUNGSAI\]|\[DUNG\/SAI\]/i.test(question)) {
            type = 'truefalse';
        } else {
            type = 'single';
        }
    }

    // Strip type tags khỏi question text
    question = question
        .replace(/\[MULTI\]/gi, '')
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
        options: options,
        correct: correct,
        correctList: type === 'multi' ? correctList : null,
        correctTF: type === 'truefalse' ? correctTF : null,
        image: q.image || null,
        points: normalizePoints(q.points)
    };
}

// Load câu hỏi từ file hoặc từ bài kiểm tra hiện tại
function loadQuestions() {
    // Nếu đang có session với examId, load từ exam đã lưu
    if (currentSession.examId) {
        var exam = loadExam(currentSession.examId);
        if (exam) {
            questions = (exam.questions || []).map(migrateQuestion);
            examSettings = mergeObjects(examSettings, exam.settings);
            examSettings.practiceMode = false;
            examSettings.showScore = false;
            examSettings.shuffleExam = true;
            examSettings.isOpen = false;
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

// ========== MÃ PIN HỌC SINH ==========
// Mỗi học sinh có 1 mã PIN riêng để chọn đúng tên khi vào phòng thi.
var studentPins = {}; // { stt: '1234' }

function getPinsKey() {
    return path.join(__dirname, 'data', 'pins', (currentSession.classId || 'default') + '.json');
}
function loadPins() {
    var data = DATA.readJson(getPinsKey(), null);
    studentPins = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}
function savePins() {
    DATA.writeJson(getPinsKey(), studentPins);
}
function generatePin(used) {
    for (var attempt = 0; attempt < 300; attempt++) {
        var pin = String(Math.floor(1000 + Math.random() * 9000));
        if (!used[pin]) return pin;
    }
    return String(Math.floor(1000 + Math.random() * 9000));
}
// Tạo PIN cho học sinh chưa có (giữ nguyên PIN cũ)
function ensurePins() {
    var used = {};
    Object.keys(studentPins).forEach(function(k) { used[studentPins[k]] = true; });
    var changed = false;
    students.forEach(function(s) {
        if (!studentPins[s.stt]) {
            var pin = generatePin(used);
            studentPins[s.stt] = pin;
            used[pin] = true;
            changed = true;
        }
    });
    if (changed) savePins();
}
// Tạo lại toàn bộ PIN cho lớp hiện tại
function regeneratePins() {
    studentPins = {};
    var used = {};
    students.forEach(function(s) {
        var pin = generatePin(used);
        studentPins[s.stt] = pin;
        used[pin] = true;
    });
    savePins();
}
// Kiểm tra PIN: nếu học sinh chưa có PIN (ví dụ dữ liệu cũ) thì cho qua
function verifyPin(stt, pin) {
    var expected = studentPins[stt];
    if (!expected) return true;
    return String(pin == null ? '' : pin).trim() === String(expected);
}

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

    // Nạp / tạo mã PIN cho lớp hiện tại
    loadPins();
    ensurePins();
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

// ========== MÃ PIN HỌC SINH (chỉ giáo viên) ==========

// Danh sách mã PIN của lớp hiện tại
app.get('/api/student-pins', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
    }
    var list = students.map(function(s) {
        return {
            stt: s.stt,
            ho: s.ho || '',
            ten: s.ten || '',
            fullName: ((s.ho || '') + ' ' + (s.ten || '')).trim(),
            pin: studentPins[s.stt] || ''
        };
    });
    res.json({
        className: currentSession.className || 'Chưa chọn lớp',
        pins: list
    });
});

// Tạo lại toàn bộ mã PIN cho lớp hiện tại
app.post('/api/student-pins/regenerate', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    regeneratePins();
    io.emit('pinsUpdated');
    res.json({ success: true, count: students.length, className: currentSession.className || 'Chưa chọn lớp' });
});

// Xuất mã PIN ra Excel
app.get('/api/student-pins/export', (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền xuất' });
    }
    var rows = students.map(function(s) {
        return {
            'STT': s.stt,
            'Họ tên': ((s.ho || '') + ' ' + (s.ten || '')).trim(),
            'Mã PIN': studentPins[s.stt] || ''
        };
    });
    var ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 6 }, { wch: 28 }, { wch: 10 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'MaPIN');
    var buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ma-pin.xlsx');
    res.send(buffer);
});

// Học sinh chọn tên
app.post('/api/select-student', (req, res) => {
    var { stt, socketId, pin } = req.body;
    
    // Kiểm tra học sinh có trong danh sách không
    var student = students.find(s => s.stt == stt);
    if (!student) {
        return res.json({ success: false, error: 'Không tìm thấy học sinh' });
    }

    // Kiểm tra mã PIN cá nhân của học sinh
    if (!verifyPin(stt, pin)) {
        return res.json({ success: false, error: 'Mã PIN không đúng. Vui lòng kiểm tra lại.', needPin: true });
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
        shuffleExam: examSettings.shuffleExam !== false
    });
});

// API kiểm tra đáp án cho chế độ ôn tập
app.post('/api/check-answer', (req, res) => {
    if (!examSettings.practiceMode) {
        return res.status(403).json({ error: 'Chế độ ôn tập chưa được bật' });
    }

    var { questionIndex, answer } = req.body;

    if (questionIndex < 0 || questionIndex >= questions.length) {
        return res.json({ error: 'Câu hỏi không hợp lệ' });
    }

    var q = migrateQuestion(questions[questionIndex]);
    var questionScore = scoreQuestion(q, answer);

    res.json({
        isCorrect: questionScore === 1,
        questionScore: questionScore,
        type: q.type || 'single',
        correctAnswer: q.correct,
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
    examSettings = mergeObjects(examSettings, req.body);
    saveCurrentSession();
    io.emit('examStatusChanged', examSettings.isOpen);
    io.emit('settingsChanged', { practiceMode: examSettings.practiceMode });
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
        examSettings = mergeObjects(examSettings, exam.settings, { isOpen: false });
        // Reset về mặc định khi chuyển đề
        examSettings.practiceMode = false;
        examSettings.showScore = false;
        examSettings.shuffleExam = true;
        examSettings.isOpen = false;
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
    examSettings = mergeObjects(examSettings, exam.settings, { isOpen: false });
    // Reset về mặc định khi chuyển đề
    examSettings.practiceMode = false;
    examSettings.showScore = false;
    examSettings.shuffleExam = true;
    examSettings.isOpen = false;
    
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
app.post('/api/exams/:examId/import-word', upload.single('file'), (req, res) => {
    if (!isTeacher(req)) {
        return res.status(403).json({ error: 'Không có quyền thực hiện' });
    }
    
    var { examId } = req.params;
    
    if (!req.file) {
        return res.json({ success: false, error: 'Không có file được upload' });
    }
    
    mammothToHtml(req.file.buffer).then(function(data) {
            var html = data.value;
            var parsedQuestions = parseQuestionsFromHtml(html);

            if (parsedQuestions.length === 0) {
                return res.json({ success: false, error: 'Không tìm thấy câu hỏi hợp lệ trong file' });
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

// ========== CHẤM ĐIỂM ==========
// Trả về số thực 0.0–1.0 (phần điểm của câu đó)
// single/multi: 0 hoặc 1 (all-or-nothing)
// truefalse: số phát biểu đúng / tổng số phát biểu (theo chuẩn BGD 2025)
function scoreQuestion(q, studentAnswer) {
    var type = q.type || 'single';

    if (type === 'single') {
        return studentAnswer === q.correct ? 1 : 0;
    }

    if (type === 'multi') {
        if (!Array.isArray(studentAnswer) || !Array.isArray(q.correctList)) return 0;
        if (studentAnswer.length !== q.correctList.length) return 0;
        var sorted1 = studentAnswer.slice().sort(function(a,b){return a-b;});
        var sorted2 = q.correctList.slice().sort(function(a,b){return a-b;});
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
        return correct / total;
    }

    return 0;
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
    
    // Chấm điểm
    var totalScore = 0; // tổng điểm thực (đã nhân trọng số từng câu)
    var totalPoints = 0; // tổng trọng số các câu (mặc định mỗi câu 1)
    var correctCount = 0;   // câu đúng hoàn toàn (score = 1)
    var partialCount = 0;   // câu đúng một phần (0 < score < 1, chỉ truefalse)
    var wrongCount = 0;     // câu sai hoàn toàn (score = 0, có trả lời)
    var unansweredCount = 0; // câu không trả lời
    var details = questions.map((q, index) => {
        q = migrateQuestion(q);
        var studentAnswer = answers[index];
        var type = q.type || 'single';
        var questionScore = scoreQuestion(q, studentAnswer); // 0.0–1.0
        var isCorrect = questionScore === 1;
        var hasAnswer = studentAnswer !== undefined && studentAnswer !== null && studentAnswer !== -1
            && !(Array.isArray(studentAnswer) && studentAnswer.length === 0);
        var qPoints = normalizePoints(q.points);
        totalScore += questionScore * qPoints;
        totalPoints += qPoints;
        if (isCorrect) correctCount++;
        else if (!hasAnswer) unansweredCount++;
        else if (questionScore > 0) partialCount++;
        else wrongCount++;

        // Nội dung đáp án để hiển thị
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
                ? studentAnswer.map(function(v, i) { return (String.fromCharCode(65+i)) + ': ' + (v === true ? 'Đúng' : v === false ? 'Sai' : '?'); }).join(', ') : null;
            correctAnswerText = Array.isArray(q.correctTF)
                ? q.correctTF.map(function(v, i) { return (String.fromCharCode(65+i)) + ': ' + (v ? 'Đúng' : 'Sai'); }).join(', ') : '';
        }

        return {
            question: q.question,
            type: type,
            studentAnswer: studentAnswer,
            studentAnswerText: studentAnswerText,
            correctAnswer: q.correct,
            correctAnswerText: correctAnswerText,
            correctList: q.correctList || null,
            correctTF: q.correctTF || null,
            isCorrect,
            questionScore: questionScore
        };
    });

    // Điểm = (tổng điểm thực đã nhân trọng số / tổng trọng số) × 10
    // Khi mọi câu đều có trọng số 1 (mặc định) thì kết quả GIỐNG HỆT công thức cũ.
    // truefalse tính partial (số phát biểu đúng / tổng phát biểu), single/multi all-or-nothing
    var score = totalPoints > 0 ? Math.round((totalScore / totalPoints) * 100) / 10 : 0;
    
    var result = {
        studentSTT,
        studentName,
        studentClass,
        score,
        correctCount,
        partialCount,
        wrongCount,
        unansweredCount,
        totalQuestions: questions.length,
        timeSpent,
        submittedAt: new Date().toLocaleString('vi-VN'),
        details
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
        score,
        correctCount,
        partialCount,
        wrongCount,
        unansweredCount,
        totalQuestions: questions.length,
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
app.post('/api/preview-word', upload.single('file'), function(req, res) {
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
            if (!q.options || q.options.length < 2) {
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
app.post('/api/import-word', upload.single('file'), async (req, res) => {
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
        var parsedQuestions = parseQuestionsFromHtml(html);

        if (parsedQuestions.length === 0) {
            return res.json({ success: false, error: 'Không tìm thấy câu hỏi nào. Kiểm tra lại định dạng file.' });
        }

        var warnings = [];
        parsedQuestions.forEach(function(q, i) {
            var num = i + 1;
            var type = q.type || 'single';
            if (!q.question || q.question.trim() === '') {
                warnings.push('Câu ' + num + ': Thiếu nội dung câu hỏi');
            }
            if (!q.options || q.options.length < 2) {
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

// Câu hỏi giữ chỗ cho 1 file ảnh: có ảnh, KHÔNG bịa nội dung/đáp án
function placeholderQuestionFromImage(dataUri) {
    return {
        type: 'single',
        question: '<img src="' + dataUri + '" />',
        options: [],
        correct: -1,
        correctList: null,
        correctTF: null,
        image: null,
        answerDetected: false,
        needsReview: true,
        reviewReasons: ['Câu hỏi tạo từ file ảnh — cần nhập nội dung chữ và đáp án.']
    };
}

// Chuẩn hoá 1 câu hỏi do client gửi về (đã qua chỉnh sửa ở bản xem trước)
function normalizeEditedQuestion(raw, qNum) {
    if (!raw || typeof raw !== 'object') return { error: 'Câu ' + qNum + ': dữ liệu không hợp lệ' };
    var type = raw.type;
    if (type !== 'single' && type !== 'multi' && type !== 'truefalse') {
        return { error: 'Câu ' + qNum + ': loại câu hỏi không hợp lệ' };
    }
    var out = {
        type: type,
        question: String(raw.question == null ? '' : raw.question),
        options: Array.isArray(raw.options) ? raw.options.map(function (o) { return String(o == null ? '' : o); }) : [],
        correct: 0,
        correctList: null,
        correctTF: null,
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
    } else {
        out.correctTF = Array.isArray(raw.correctTF)
            ? raw.correctTF.map(function (v) { return v === true ? true : (v === false ? false : null); })
            : [];
    }
    return { question: out };
}

// ---- Bước 1: phân tích file -> trả về bản xem trước để giáo viên sửa ----
app.post('/api/import/preview',
    importUploadMiddleware('files', fileValidate.FILE_LIMITS.maxImageCount + 1),
    function (req, res) {
        if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền' });

        var files = req.files || [];
        if (files.length === 0) {
            return res.json({ success: false, error: 'Chưa chọn file nào.' });
        }

        // 1) Kiểm tra định dạng + dung lượng từng file
        var docxFile = null;
        var imageFiles = [];
        var errors = [];
        var totalBytes = 0;

        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            totalBytes += (f.size || (f.buffer ? f.buffer.length : 0));
            var v = fileValidate.validateUpload(f);
            if (!v.ok) { errors.push(v.error); continue; }
            if (v.kind === 'docx') {
                if (docxFile) { errors.push('Mỗi lần chỉ nhập được 1 file Word. Đã bỏ qua "' + f.originalname + '".'); continue; }
                docxFile = f;
            } else {
                imageFiles.push({ file: f, imageType: v.imageType });
            }
        }

        if (totalBytes > fileValidate.FILE_LIMITS.maxTotalBytes) {
            return res.json({
                success: false,
                error: 'Tổng dung lượng quá lớn (tối đa ' +
                    Math.round(fileValidate.FILE_LIMITS.maxTotalBytes / 1024 / 1024) + ' MB).'
            });
        }
        if (!docxFile && imageFiles.length === 0) {
            return res.json({ success: false, error: errors.join(' ') || 'Không có file hợp lệ.' });
        }

        // 2) Phân tích file Word (nếu có)
        var parsePromise = Promise.resolve([]);
        if (docxFile) {
            parsePromise = mammothToHtml(docxFile.buffer).then(function (result) {
                return parseQuestionsFromHtml(result.value, { trackReview: true });
            });
        }

        parsePromise.then(function (docxQuestions) {
            var questions = docxQuestions.slice();

            // Ảnh rời: mỗi ảnh thành 1 câu giữ chỗ, đánh dấu cần giáo viên nhập
            imageFiles.forEach(function (item) {
                var dataUri = 'data:' + item.imageType + ';base64,' + item.file.buffer.toString('base64');
                questions.push(placeholderQuestionFromImage(dataUri));
            });

            // 3) Tách ảnh thành token cho payload xác nhận gọn nhẹ
            var pool = extractImagesToTokens(questions);

            // 4) Lưu phiên (RAM, có TTL, tự dọn)
            var sessionId = importSessions.create({ pool: pool });

            var needsReview = questions.filter(function (q) { return q.needsReview; }).length;

            res.json({
                success: true,
                sessionId: sessionId,
                count: questions.length,
                needsReview: needsReview,
                warnings: errors,
                imagePool: pool,
                source: {
                    docx: docxFile ? docxFile.originalname : null,
                    images: imageFiles.map(function (it) { return it.file.originalname; })
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
                        points: normalizePoints(q.points),
                        needsReview: !!q.needsReview,
                        reviewReasons: q.reviewReasons || [],
                        answerDetected: detected
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
    }
);

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

    incoming.forEach(function (raw, i) {
        var num = i + 1;
        if (raw && raw.include === false) return;

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

    if (destination === 'current') {
        questions = questions.concat(saved);
        saveQuestions();
        io.emit('questionsUpdated', questions.length);
        importSessions.remove(body.sessionId);
        return res.json({
            success: true, destination: 'current',
            saved: saved.length, skipped: skipped, total: questions.length
        });
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

    res.json({
        success: true, destination: 'new',
        examId: newExamId, examName: examData.name,
        saved: saved.length, skipped: skipped, total: saved.length
    });
});

// ===========================================================================
// NHẬP ĐỀ TỪ ẢNH BẰNG OCR
// ===========================================================================
// Tách bước rõ ràng:
//   B1  POST /api/ocr/extract   - upload (RAM) + kiểm tra + OCR      -> sessionId
//   B2  POST /api/ocr/analyze   - chuẩn hoá + phân tích -> xem trước (chưa lưu)
//   B3  POST /api/import/confirm- giáo viên xác nhận -> mới ghi dữ liệu
// Ảnh KHÔNG ghi ra đĩa: multer dùng memoryStorage, OCR nhận Buffer trực tiếp.
// Không tự bịa câu hỏi/đáp án: câu thiếu đáp án có correct = null + needsReview.

var OCR_MAX_CHARS = ocrParse.MAX_TEXT_CHARS;

// B1: upload + OCR
app.post('/api/ocr/extract',
    importUploadMiddleware('files', fileValidate.FILE_LIMITS.maxImageCount),
    async function (req, res) {
        if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền' });

        var files = req.files || [];
        if (files.length === 0) {
            return res.json({ success: false, error: 'Chưa chọn ảnh nào.' });
        }

        var images = [];
        var errors = [];
        var totalBytes = 0;

        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            totalBytes += (f.size || (f.buffer ? f.buffer.length : 0));
            var v = fileValidate.validateUpload(f);
            if (!v.ok) { errors.push(v.error); continue; }
            if (v.kind !== 'image') {
                errors.push('"' + f.originalname + '" không phải ảnh. Bước này chỉ nhận ảnh');
                continue;
            }
            images.push({ name: f.originalname, buffer: f.buffer, mime: v.imageType });
        }

        if (totalBytes > fileValidate.FILE_LIMITS.maxTotalBytes) {
            return res.json({
                success: false,
                error: 'Tổng dung lượng quá lớn (tối đa ' +
                    Math.round(fileValidate.FILE_LIMITS.maxTotalBytes / 1024 / 1024) + ' MB).'
            });
        }
        if (images.length === 0) {
            return res.json({ success: false, error: errors.join(' ') || 'Không có ảnh hợp lệ.' });
        }

        // OCR tuần tự từng ảnh để giới hạn RAM
        var results = [];
        var parts = [];
        try {
            for (var k = 0; k < images.length; k++) {
                var img = images[k];
                var out = await ocr.recognize(img.buffer, img.mime);
                results.push({
                    name: img.name,
                    provider: out.provider,
                    confidence: out.confidence,
                    chars: (out.text || '').length
                });
                parts.push(out.text || '');
            }
        } catch (err) {
            console.error('Lỗi OCR:', err);
            return res.json({
                success: false,
                error: 'OCR thất bại: ' + ((err && err.message) || 'lỗi không xác định') +
                    '. Hãy thử ảnh rõ hơn hoặc kiểm tra cấu hình OCR.'
            });
        }

        var text = parts.join('\n\n');
        if (text.length > OCR_MAX_CHARS) text = text.slice(0, OCR_MAX_CHARS);

        var sessionId = importSessions.create({ ocr: { images: results, text: text } });

        res.json({
            success: true,
            sessionId: sessionId,
            provider: ocr.resolveProvider(),
            images: results,
            chars: text.length,
            // Van ban tho de giao vien doi chieu voi anh
            text: text,
            warnings: errors
        });
    }
);

// B2: phân tích văn bản OCR thành câu hỏi (xem trước, CHƯA lưu)
app.post('/api/ocr/analyze', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền' });

    var sessionId = (req.body || {}).sessionId;
    var session = importSessions.get(sessionId);
    if (!session || !session.ocr || !session.ocr.text) {
        return res.json({ success: false, error: 'Phiên OCR đã hết hạn hoặc không tồn tại. Vui lòng chọn ảnh lại.' });
    }

    var raw = session.ocr.text;
    var info = ocrParse.analyze(raw);

    if (info.questionMarkers === 0) {
        return res.json({
            success: false,
            ocrIssues: true,
            error: 'OCR không nhận ra câu hỏi nào (ảnh có thể mờ, nghiêng hoặc không có chữ). ' +
                'Hãy thử ảnh rõ hơn, chụp thẳng và đủ sáng.',
            questionMarkers: info.questionMarkers,
            optionMarkers: info.optionMarkers,
            text: raw
        });
    }

    var parsed = parseQuestionsFromText(info.normalized, { trackReview: true });
    if (!parsed || parsed.length === 0) {
        return res.json({
            success: false,
            ocrIssues: true,
            error: 'Có dấu hiệu câu hỏi nhưng chưa tách được câu nào hoàn chỉnh. ' +
                'Ảnh có thể bị mờ hoặc thiếu đáp án.',
            questionMarkers: info.questionMarkers,
            optionMarkers: info.optionMarkers,
            text: raw
        });
    }

    var questions = parsed.map(function (q, idx) {
        var detected = !!q.answerDetected;
        return {
            index: idx,
            type: q.type || 'single',
            question: q.question || '',
            options: q.options || [],
            // Không xác định được đáp án đúng -> null + đánh dấu cần kiểm tra
            correct: (detected && typeof q.correct === 'number' && q.correct >= 0) ? q.correct : null,
            correctList: (q.correctList && q.correctList.length) ? q.correctList : null,
            correctTF: q.correctTF || null,
            points: 1,
            needsReview: !!q.needsReview,
            reviewReasons: (q.reviewReasons || []).slice(),
            answerDetected: detected,
            source: 'ocr'
        };
    });

    session.pool = session.pool || {};
    session.ocr.questions = questions;

    var needsReview = questions.filter(function (q) { return q.needsReview; }).length;

    res.json({
        success: true,
        sessionId: sessionId,
        count: questions.length,
        needsReview: needsReview,
        warnings: [],
        imagePool: session.pool,
        source: { ocr: (session.ocr.images || []).map(function (im) { return im.name; }) },
        ocr: {
            provider: ocr.resolveProvider(),
            questionMarkers: info.questionMarkers,
            optionMarkers: info.optionMarkers
        },
        questions: questions
    });
});

// Trạng thái OCR (để giao diện biết đã sẵn sàng chưa)
app.get('/api/ocr/status', function (req, res) {
    if (!isTeacher(req)) return res.status(403).json({ error: 'Không có quyền' });
    res.json({ success: true, ocr: ocr.status() });
});

// ========== HTML SANITIZER (server-side, regex-based) ==========
var ALLOWED_HTML_TAGS = {
    'b': [], 'strong': [], 'i': [], 'em': [], 'u': [],
    'p': [], 'br': [], 'span': ['style'], 'sub': [], 'sup': [],
    'img': ['src', 'alt', 'width', 'height', 'style'],
    'pre': [], 'code': []
};

function sanitizeStyleAttr(style) {
    if (/url\s*\(|expression\s*\(|javascript:/i.test(style)) return '';
    var safeParts = [];
    var declarations = style.split(';');
    var SAFE_PROPS = ['color','background-color','font-size','font-weight','font-style',
                      'text-decoration','vertical-align','width','height','max-width','max-height'];
    for (var i = 0; i < declarations.length; i++) {
        var parts = declarations[i].split(':');
        if (parts.length >= 2) {
            var prop = parts[0].trim().toLowerCase();
            var val = parts.slice(1).join(':').trim();
            if (SAFE_PROPS.indexOf(prop) >= 0 && !/url|expression|javascript/i.test(val)) {
                safeParts.push(prop + ':' + val);
            }
        }
    }
    return safeParts.join(';');
}

function sanitizeHtml(html) {
    if (!html || typeof html !== 'string') return '';
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/gi, function(fullMatch, tagName, attrs) {
        var lowerTag = tagName.toLowerCase();
        if (fullMatch.charAt(1) === '/') {
            return ALLOWED_HTML_TAGS.hasOwnProperty(lowerTag) ? '</' + lowerTag + '>' : '';
        }
        if (!ALLOWED_HTML_TAGS.hasOwnProperty(lowerTag)) return '';
        var allowedAttrs = ALLOWED_HTML_TAGS[lowerTag];
        var cleanAttrs = '';
        for (var i = 0; i < allowedAttrs.length; i++) {
            var attrName = allowedAttrs[i];
            var attrRegex = new RegExp(attrName + '\\s*=\\s*("([^"]*)"' + "|'([^']*)'|(\\S+))", 'i');
            var attrMatch = attrs.match(attrRegex);
            if (attrMatch) {
                var attrVal = attrMatch[2] !== undefined ? attrMatch[2] : (attrMatch[3] !== undefined ? attrMatch[3] : (attrMatch[4] || ''));
                if (attrName === 'src') {
                    if (attrVal.indexOf('data:image/') !== 0) continue;
                }
                if (attrName === 'style') {
                    attrVal = sanitizeStyleAttr(attrVal);
                    if (!attrVal) continue;
                }
                cleanAttrs += ' ' + attrName + '="' + attrVal + '"';
            }
        }
        var selfClose = (lowerTag === 'br' || lowerTag === 'img') ? ' /' : '';
        return '<' + lowerTag + cleanAttrs + selfClose + '>';
    });
    return html.trim();
}

// ========== OMML -> LATEX CONVERTER ==========
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
            var hide = pr && (pr.elements||[]).find(function(c){ return (c.name||'').replace('m:','') === 'degHide'; });
            var deg = latexChild('deg'); var e = latexChild('e');
            if (hide || !deg.trim()) return '\\sqrt{' + e + '}';
            return '\\sqrt[' + deg + ']{' + e + '}';
        }
        case 'nary': {
            var nPr = child('naryPr');
            var chrEl = nPr && (nPr.elements||[]).find(function(c){ return (c.name||'').replace('m:','') === 'chr'; });
            var chr = chrEl && chrEl.attributes && (chrEl.attributes['m:val'] || chrEl.attributes.val);
            var symMap = {'\u222B':'\\int','\u222C':'\\iint','\u222D':'\\iiint','\u2211':'\\sum','\u220F':'\\prod','\u222E':'\\oint'};
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
            return '\\left' + beg + inner + '\\right' + end;
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
        case 'r': case 't': case 'e': case 'num': case 'den': case 'sup': case 'sub':
        case 'deg': case 'lim': case 'fName': return latex(children);
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
                    var placeholder = 'MATHPLACEHOLDER' + counter + 'END';
                    mathMap[placeholder] = latexStr;
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
                    "p[style-name='Code'] => pre"
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
                html = html.split(placeholder).join('\\(' + data.mathMap[placeholder] + '\\)');
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
    return html.replace(/\*|\[x\]|\[X\]/g, '').replace(/\(đúng\)|\(dung\)/gi, '').trim();
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

function stripOptionPrefix(html) {
    return html.replace(/^[A-Za-z][\.\)]\s*/, '');
}

function stripQuestionPrefix(html) {
    // Loại bỏ "Câu N:" hoặc "N." ở đầu
    return html.replace(/^(Câu\s*\d+[\.:]\s*|\d+[\.:]\s*)/i, '');
}

function stripTypeTags(html) {
    return html.replace(/\[MULTI\]/gi, '')
               .replace(/\[ĐÚNG\/SAI\]/gi, '')
               .replace(/\[DUNGSAI\]/gi, '')
               .replace(/\[DUNG\/SAI\]/gi, '')
               .trim();
}

function buildQuestionObj(type, question, options, correctAnswer, correctList, correctTF, opts) {
    opts = opts || {};
    var answerDetected;
    if (type === 'multi') {
        answerDetected = !!(correctList && correctList.length > 0);
    } else if (type === 'truefalse') {
        answerDetected = !!(correctTF && correctTF.length > 0) &&
            correctTF.every(function (v) { return v === true || v === false; });
    } else {
        answerDetected = correctAnswer >= 0;
    }

    var obj = {
        type: type,
        question: sanitizeHtml(question),
        options: options.map(function(o) { return sanitizeHtml(o); }),
        correct: correctAnswer >= 0 ? correctAnswer : 0,
        correctList: type === 'multi' ? correctList : null,
        correctTF: type === 'truefalse' ? correctTF : null,
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
    var currentReasons = [];

    // Đẩy câu hỏi đang dựng vào kết quả.
    // Chế độ xem trước (opts.trackReview): giữ cả câu thiếu đáp án/đáp án <2 và
    // gắn cờ "cần kiểm tra" thay vì âm thầm bỏ hoặc tự bịa đáp án.
    function pushCurrent() {
        if (currentQuestion === null) return;
        var enoughOptions = currentOptions.length >= 2;
        if (!opts.trackReview && !enoughOptions) return;

        var obj = buildQuestionObj(currentType, currentQuestion, currentOptions, correctAnswer, correctList, correctTF, opts);

        if (opts.trackReview) {
            var reasons = currentReasons.slice();
            var qPlain = stripHtmlTags(obj.question).trim();
            var qHasImg = /<img\b/i.test(obj.question);
            if (qPlain === '' && qHasImg) {
                reasons.push('Câu hỏi chỉ có hình ảnh — cần bổ sung nội dung chữ.');
            } else if (qPlain === '') {
                reasons.push('Thiếu nội dung câu hỏi.');
            }
            if (!enoughOptions) {
                reasons.push('Chỉ có ' + currentOptions.length + ' đáp án (cần ít nhất 2).');
            }
            if (!obj.answerDetected) {
                reasons.push('Chưa xác định được đáp án đúng — giáo viên cần chọn.');
            }
            obj.reviewReasons = reasons;
            obj.needsReview = reasons.length > 0;
        }
        parsedQuestions.push(obj);
    }

    for (var i = 0; i < paragraphs.length; i++) {
        var paraHtml = paragraphs[i];
        var plainText = stripHtmlTags(paraHtml);

        var questionMatch = plainText.match(/^(Câu\s*\d+[\.:]\s*|\d+[\.:]\s*)(.*)/i);
        if (questionMatch) {
            pushCurrent();
            currentType = 'single';
            correctAnswer = -1;
            correctList = [];
            correctTF = [];
            currentOptions = [];
            currentReasons = [];

            if (/\[MULTI\]/i.test(plainText)) {
                currentType = 'multi';
            } else if (/\[ĐÚNG\/SAI\]|\[DUNGSAI\]|\[DUNG\/SAI\]/i.test(plainText)) {
                currentType = 'truefalse';
            }

            // Lấy inner HTML của câu hỏi, bỏ prefix "Câu N:" và type tags
            var qHtml = stripQuestionPrefix(stripTypeTags(paraHtml));
            // Nếu plain text prefix còn sót lại
            qHtml = qHtml.replace(/^(Câu\s*\d+[\.:]\s*|\d+[\.:]\s*)/i, '');
            currentQuestion = qHtml.trim();
            continue;
        }

        var optionMatch = plainText.match(/^([A-Za-z])[\.\)]\s*(.*)/);
        if (optionMatch && currentQuestion !== null) {
            var optLetter = optionMatch[1].toUpperCase();
            var optIndex = optLetter.charCodeAt(0) - 65;
            var optHtml = stripOptionPrefix(paraHtml).trim();

            if (currentType === 'single') {
                if (plainText.indexOf('*') >= 0 || /\(đúng\)|\(dung\)/i.test(plainText)) {
                    correctAnswer = optIndex;
                }
                optHtml = removeCorrectMarkers(optHtml);
            } else if (currentType === 'multi') {
                if (plainText.indexOf('*') >= 0 || /\(đúng\)|\(dung\)/i.test(plainText)) {
                    correctList.push(optIndex);
                }
                optHtml = removeCorrectMarkers(optHtml);
            } else if (currentType === 'truefalse') {
                correctTF[optIndex] = TF_TRUE_REGEX.test(plainText);
                optHtml = removeTFMarkers(optHtml);
            }

            while (currentOptions.length < optIndex) currentOptions.push('');
            currentOptions[optIndex] = optHtml;
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

    return parsedQuestions;
}

// ========== VALIDATE CÂU HỎI (dùng chung) ==========
// Trong so diem cua 1 cau (mac dinh 1). Giu tuong thich nguoc: khong co
// `points` thi diem van duoc tinh nhu cu (moi cau trong so 1).
function normalizePoints(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 1;
    if (n > 100) return 100;
    return Math.round(n * 100) / 100;
}

function validateAndNormalizeQuestion(q, qNum, errors) {
    if (!q.question || q.question.trim() === '') {
        errors.push('Câu ' + qNum + ': Thiếu nội dung câu hỏi');
        return null;
    }
    if (!q.options || !Array.isArray(q.options) || q.options.length < 2) {
        errors.push('Câu ' + qNum + ': Thiếu hoặc không đủ đáp án (cần ít nhất 2)');
        return null;
    }

    var type = q.type || 'single';

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
            points: normalizePoints(q.points)
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
            points: normalizePoints(q.points)
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
            points: normalizePoints(q.points)
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
    // Khoi dong truoc OCR o nen: tai du lieu ngon ngu tesseract ngay khi boot
    // de request dau tien cua giao vien khong bi cham (Render proxy timeout).
    ocr.warmUp().then(function(ok) {
        if (ok) safeLog('[OCR] San sang (tesseract, ngon ngu: ' + ocr.getLangs().join('+') + ').');
    });
}).catch(function(err) {
    safeLog('[LOI] Khoi tao storage that bai: ' + (err && err.message));
    process.exit(1);
});

// Xu ly tat server: SIGINT (local) va SIGTERM (Render khi deploy/restart)
function shutdown(signal) {
    safeLog('');
    safeLog('Nhan tin hieu ' + signal + '. Dang tat server...');
    Promise.resolve(ocr.terminate()).catch(function() { return null; }).then(function() {
        return DATA.flush();
    }).then(function() {
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
