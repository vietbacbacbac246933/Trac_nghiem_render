# BÁO CÁO CHUYỂN BẢN LAN → ONLINE (Render)

Thư mục bản deploy: `C:\Users\vietb\Trac_nghiem_render`
Bản LAN gốc (không đổi): `C:\Users\vietb\Trac_nghiem_LAN`

---

## 1. Tóm tắt thay đổi

Giữ nguyên kiến trúc (Node.js + Express + Socket.IO, HTML thuần) và toàn bộ
nghiệp vụ. Chỉ thay lớp hạ tầng theo nhu cầu chạy trên Internet.

| # | Vấn đề khi lên Internet | Cách xử lý |
|---|---|---|
| 1 | Cổng bị hard-code 3456 | Đọc `process.env.PORT` |
| 2 | Trang giáo viên chỉ chặn theo `localhost` (Internet sẽ hở) | Đăng nhập bằng `TEACHER_PASSWORD` + cookie ký HMAC |
| 3 | `/teacher.html` mở tự do qua static | Chặn, chuyển về `/teacher/login` |
| 4 | File lưu trong `data/` (ổ đĩa Render tạm, mất khi restart) | PostgreSQL khi có `DATABASE_URL`, không thì vẫn dùng file |
| 5 | `/api/settings`, `/api/session` lộ mật khẩu phòng thi | Ẩn với người không phải giáo viên |
| 6 | `/data/*.json` tải trực tiếp được (lộ đáp án) | Chỉ cho tải 2 file mẫu; chặn toàn bộ `.json` |
| 7 | Học sinh chọn tên tự do | Mã PIN riêng cho từng học sinh |
| 8 | Trang phụ `simple.html` chọn tên **không cần PIN** | Đã xoá (cùng `debug.html`, `test.html`) |
| 9 | Thiếu khai báo gói `jszip`, `xml-js` | Thêm vào `package.json` |
| 10 | Không bắt tín hiệu tắt của Render | Bắt `SIGTERM`/`SIGINT`, ghi nốt dữ liệu rồi thoát |
| 11 | Nhập đề thủ công tốn thời gian | Thêm nhập đề từ **Word (.docx) / ảnh** và từ **ảnh bằng OCR** (tesseract.js) — có bản xem trước cho sửa, không tự bịa đáp án |

---

## 2. Danh sách file thay đổi

### File mới
| File | Vai trò |
|---|---|
| `lib/datastore.js` | Lớp lưu trữ: PostgreSQL hoặc file JSON. Bảng `quiz_kv (key, value jsonb, updated_at)`. Tự gieo dữ liệu từ `data/` khi DB trống. |
| `lib/auth.js` | Xác thực giáo viên: cookie `quiz_teacher` ký HMAC, hết hạn 12h, httpOnly, SameSite=Strict; chống dò mật khẩu theo IP. |
| `public/teacher-login.html` | Trang đăng nhập giáo viên. |
| `render.yaml` | Blueprint deploy Render (Web Service + PostgreSQL). |
| `.env.example` | Mẫu biến môi trường. |
| `README.md` | Hướng dẫn dùng & triển khai. |

### File mới (tính năng nhập đề Word/Ảnh)
| File | Vai trò |
|---|---|
| `lib/file-validate.js` | Nhận dạng `.docx` (chữ ký ZIP) và ảnh (PNG/JPEG/GIF/BMP/WEBP) theo nội dung thật; giới hạn `.docx` 15 MB, ảnh 8 MB, tổng 25 MB, ≤ 30 ảnh. |
| `lib/import-sessions.js` | Lưu tạm kết quả phân tích để giáo viên xem/sửa trước khi lưu; ảnh giữ trong RAM dưới dạng token `[[IMG:n]]`; hết hạn 30 phút. |
| `tests/test-import-docx.js` | Test DOCX hợp lệ, thiếu đáp án, sai định dạng, file giả, docx hỏng, ảnh, quá dung lượng, chặn ẩn danh, chống lưu lặp. |

### File mới (tính năng nhập đề từ ẢNH bằng OCR)
| File | Vai trò |
|---|---|
| `lib/ocr.js` | Trích xuất chữ từ ảnh. Mặc định **tesseract.js** (WASM, chạy trong tiến trình Node, miễn phí, không cần API key, không cần cài gói hệ thống nên chạy được trên Render Node thuần); tuỳ chọn **OCR.space** qua biến môi trường `OCR_SPACE_API_KEY`. Chỉ nhận `Buffer` trong RAM; xếp hàng tuần tự để giới hạn RAM. |
| `lib/ocr-parse.js` | Chuẩn hoá văn bản OCR (`Cau 1`→`Câu 1`, `A.4`→`A. 4`, gộp dòng, bỏ tiền tố rác/số trang) và đánh giá “có giống đề thi không” để báo lỗi khi ảnh mờ. |
| `tests/test-ocr-import.js` | Test OCR (69 trường hợp): ảnh rõ, nhiều câu, ảnh mờ/không đọc được, câu thiếu đáp án, sai định dạng, quá dung lượng, sửa trước khi lưu, hủy không tạo dữ liệu, lưu rồi mở lại, chống lặp phiên, chặn ẩn danh, không ghi ảnh người dùng lên đĩa. |
| `tests/fixtures/*.png` + `make-fixtures.ps1` | Ảnh đề mẫu (4 câu, 8 câu, ảnh mờ) và script GDI+ tạo lại. |

### File sửa
| File | Nội dung chính |
|---|---|
| `server.js` | PORT động; trust proxy; guard `/teacher.html`; route `/teacher`, `/teacher/login`, `/api/teacher/login|logout|session`; thay `isLocalhost`→`isTeacher` (49 chỗ); toàn bộ đọc/ghi dữ liệu chuyển qua `DATA.*`; ẩn `examPassword`; quản lý PIN + `/api/student-pins*`; `/api/select-student` đòi PIN; bootstrap bất đồng bộ + shutdown. **Thêm:** `/api/import/preview`, `/api/import/confirm`, `GET /api/exams/:examId`; multer riêng có giới hạn + lọc định dạng; `parseQuestionsFromHtml` chế độ `trackReview` (đánh dấu câu cần kiểm tra, không tự gán đáp án). **Thêm (OCR):** `/api/ocr/extract`, `/api/ocr/analyze`, `/api/ocr/status`; trường `points` (trọng số) trong chuẩn hoá câu hỏi + công thức chấm điểm quy về thang 10 theo trọng số (không có `points` thì y như cũ); nạp trước OCR lúc khởi động và giải phóng worker khi tắt. |
| `package.json` | Thêm `jszip`, `xml-js`, `pg`, `tesseract.js`; `engines.node >= 18`; thêm script `test:import`, `test:ocr`. |
| `public/teacher.html` | Nút Đăng xuất; tự chuyển trang khi 401; nút + hộp thoại “Mã PIN học sinh” (xem/tạo lại/tải Excel). **Thêm:** nút “Nhập Word/Ảnh” + modal xem trước cho sửa (nội dung, đáp án, loại câu, chọn đáp án đúng) và chọn nơi lưu. **Thêm (OCR):** nút “📷 Nhập từ ảnh (OCR)”, modal chọn/xoá ảnh (thumbnail + nút ✕), xem văn bản OCR để đối chiếu, và ô **Điểm** từng câu trong bản xem trước. |
| `.env.example` | Thêm `OCR_PROVIDER`, `OCR_LANGS`, `OCR_SPACE_API_KEY`, `OCR_DEBUG`. |
| `public/index.html` | Hộp thoại nhập PIN khi chọn tên; gửi `{stt, socketId, pin}`. |
| `.gitignore` | Bỏ qua dữ liệu chạy + thông tin học sinh (mục 6). |

### File đã xoá (có chủ đích)
`public/simple.html`, `public/debug.html`, `public/test.html`
→ Trang chẩn đoán cũ, không được link ở đâu, nhưng `simple.html` chọn tên **bỏ
qua PIN** và `debug/test` hiển thị số lượng + tên học sinh cho bất kỳ ai.
Bản gốc vẫn giữ nguyên trong `Trac_nghiem_LAN` nếu cần tham khảo.

---

## 3. Cách chạy thử ở máy (không cần Postgres)

```powershell
cd C:\Users\vietb\Trac_nghiem_render
npm install
$env:TEACHER_PASSWORD = "mat-khau-cua-ban"
$env:PORT = "3456"
node server.js
```
- Học sinh: http://localhost:3456/
- Giáo viên: http://localhost:3456/teacher
- Kiểm tra: http://localhost:3456/api/ping

---

## 4. Triển khai trên Render

### Bước chuẩn bị
1. Tạo repo GitHub **riêng** cho bản này (không đẩy `.env`, `node_modules`,
   `data/class-students/`, `danhsach/`).
2. Trong GitHub Desktop/CLI: `git init` → `git add .` → `git commit` → `git push`.

### Cách A — Blueprint (nhanh)
1. Render → **New** → **Blueprint** → chọn repo.
2. Render đọc `render.yaml` → tạo Web Service + PostgreSQL.
3. Nhập `TEACHER_PASSWORD` khi được hỏi → **Apply**.

### Cách B — Tạo tay
1. **New → PostgreSQL** (Free) → lấy **Internal Database URL**.
2. **New → Web Service** → chọn repo:
   - Build: `npm install`
   - Start: `npm start`
   - Health Check Path: `/api/ping`
3. Environment: `TEACHER_PASSWORD`, `DATABASE_URL`, `SESSION_SECRET`
   (nút Generate), `NODE_VERSION=18`.
4. Deploy.

### Biến môi trường
| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `PORT` | Không | Render tự cấp, không đặt tay |
| `TEACHER_PASSWORD` | **Có** | Mật khẩu giáo viên |
| `SESSION_SECRET` | Nên có | Khoá ký cookie; bỏ trống sẽ suy ra từ `TEACHER_PASSWORD` |
| `DATABASE_URL` | **Có** | `postgresql://...` |
| `PG_POOL_MAX` | Không | Mặc định 5 |
| `NODE_ENV` | Không | `production` |
| `OCR_PROVIDER` | Không | `auto` / `tesseract` / `ocrspace` (mặc định `auto`) |
| `OCR_LANGS` | Không | Mặc định `vie+eng` |
| `OCR_SPACE_API_KEY` | Không | Chỉ cần khi muốn dùng OCR.space |

> Chỉ chạy **1 instance** (Socket.IO giữ kết nối trong RAM của process).
> OCR **không** cần biến môi trường nào: mặc định tesseract.js chạy trong
> process nên deploy Render hiện tại (Node thuần) không phải đổi gì.

---

## 5. Kiểm thử đã chạy (bằng chứng thực tế)

Chạy tại máy với `TEACHER_PASSWORD=test123`, 2 học sinh mẫu.

### A. Chế độ FILESYSTEM — 46/46 đạt
- Cơ bản (21): ping; chặn `/teacher`, `/teacher.html`; chặn tải
  `questions.json`/`exams/*.json`/`classes.json`; cho tải 2 file mẫu; ẩn
  `examPassword`; ẩn `/api/session`; đăng nhập sai/đúng; cookie httpOnly;
  truy cập giáo viên; đăng xuất.
- PIN (13): tạo PIN 4 số duy nhất; chọn thiếu PIN / sai PIN bị chặn; đúng PIN
  thành công; không cướp được tên của phiên khác; tạo lại PIN làm PIN cũ hết
  hiệu lực; xuất Excel; chặn xuất khi ẩn danh.
- Đề thi (12): mở đề; `/api/exam` cho học sinh **không chứa** `correct`,
  `correctList`, `correctTF`; nộp đúng hết = 10 điểm; sai hết = 0 điểm; chặn
  nộp lại; đọc/xuất kết quả; đóng đề.

### B. Import Word/JSON — 5/5 đạt
`/api/import-word` đọc file `mau-cau-hoi.docx` ra 11 câu; `/api/import-json-file`
đọc 10 câu; chặn khi ẩn danh.

### C. Chế độ POSTGRES — thực tế, không mô phỏng
Dùng một PostgreSQL 18 tạm (`embedded-postgres`, cổng 55432) — **không đụng**
vào dịch vụ PostgreSQL sẵn có trên máy.
- Khởi động: `[STORE] PostgreSQL trong -> da seed 11 ban ghi tu data/`,
  chế độ `postgres`.
- Chạy lại **toàn bộ** bộ test **48/48 đạt** (21 + 13 + 14).
- Kiểm tra trực tiếp bảng `quiz_kv`: 15 dòng, gồm `data/questions.json` (mảng
  20 câu), `data/results.json` (2 kết quả), `data/pins/default.json`, các đề
  thi, `student-status`, `current-session`.
- **Tắt rồi mở lại server**: log `[STORE] PostgreSQL: da nap 15 ban ghi`
  (nạp lại, không gieo lại); 2 kết quả vẫn còn (An: 10, Bình: 0); PIN giữ
  nguyên → **dữ liệu bền vững qua restart**.

### D. Kiểm tra toàn vẹn dữ liệu
`data/questions.json` và 8 file `data/exams/*.json` khớp MD5 tuyệt đối với bản
gốc (không bị sửa nhầm trong quá trình test).

### E. Nhập đề từ Word/Ảnh — 38/38 đạt
`node tests/test-import-docx.js` (server cổng 3999, `TEACHER_PASSWORD=test123`):

- **DOCX hợp lệ**: `mau-cau-hoi`/đề tự sinh → nhận đúng 2 câu, đúng đáp án `*`,
  câu 1 không bị đánh dấu.
- **Thiếu đáp án**: câu không có dấu đáp án → `needsReview = true`,
  `correct = null` (**không** tự gán đáp án A), có lý do cụ thể.
- **Xác nhận lưu**: câu thiếu đáp án bị **bỏ qua** kèm lý do; bài mới chỉ chứa
  câu hợp lệ (kiểm chứng lại bằng `GET /api/exams/:examId`).
- **Chống lưu lặp**: gọi lại cùng `sessionId` → bị từ chối.
- **Sai định dạng**: `.txt` → HTTP 400; file `.docx` giả (nội dung là văn bản
  thường) → bị chặn nhờ kiểm tra magic bytes.
- **Lỗi đọc file**: `.docx` hỏng (ZIP rác) → trả `success:false` kèm thông báo,
  **server không sập**.
- **Ảnh**: ảnh PNG → tạo câu giữ chỗ có ảnh, đánh dấu cần kiểm tra; chưa nhập
  đáp án thì **không lưu**; sau khi bổ sung thì lưu được và ảnh được thay từ
  token `[[IMG:0]]` thành `<img src="data:image/png;base64,...">` (kiểm chứng
  bằng `GET /api/exams/:examId`).
- **Quá dung lượng**: file 16 MB → HTTP 400.
- **Bảo vệ**: `preview`/`confirm` khi ẩn danh → 403.
- Test tự xoá các bài kiểm tra nó tạo ra và **không** đổi bài đang soạn.

### F. Kiểm thử giao diện thật (Chromium)
Mở `/teacher` trên trình duyệt (đã đăng nhập), chạy luồng nhập đề bằng chính
hàm của trang (`startImportPreview` → `renderImportPreview` → `confirmImportPreview`):

- 11 thẻ câu hỏi + 11 ô nội dung + 44 ô đáp án được dựng; 5 nhãn “cần kiểm tra”.
- Chọn đáp án đúng → nhãn đổi ngay sang “OK”; thêm đáp án, sửa nội dung câu đều
  cập nhật đúng vào dữ liệu.
- Bấm **Xác nhận lưu** → lưu 11 câu vào bài mới, đóng modal, xoá sạch bản xem
  trước. Không có lỗi nào trong Console.
- Đã xoá bài kiểm tra test; 8 đề gieo ban đầu còn nguyên.

### G. Nhập đề từ ẢNH bằng OCR — 69/69 đạt
`node tests/test-ocr-import.js` (server cổng 3999, `TEACHER_PASSWORD=test123`).
Ảnh mẫu sinh bằng GDI+ (`tests/fixtures/`), OCR bằng tesseract.js `vie+eng`.

- **Ảnh rõ chữ** (`de-thi-4cau.png`): `/api/ocr/extract` đọc 349 ký tự
  (confidence 93) → `/api/ocr/analyze` tách **đúng 4 câu**, mỗi câu **đủ 4 đáp
  án**, nội dung/đáp án khớp ảnh.
- **Đáp án đúng lấy từ dấu `*` trong ảnh**: câu 1 → B (1), câu 2 → C (2),
  câu 3 → A (0); câu có dấu `*` **không** bị đánh dấu cần kiểm tra.
- **Câu không có đáp án trong ảnh** (câu 4): `correct = null`,
  `needsReview = true`, có lý do; tổng “cần kiểm tra” = 1.
- **Ảnh nhiều câu** (`de-thi-8cau.png`): tách **đúng 8 câu**, 8/8 câu đủ đáp án.
- **Ảnh mờ / không có chữ** (`anh-mo.png`): analyze trả `success:false` +
  `ocrIssues:true` + `questionMarkers:0` + hướng dẫn chụp lại,
  **không** tạo câu hỏi nào; vẫn trả văn bản OCR để đối chiếu.
- **Sai định dạng / sai kiểu**: `.txt` → HTTP 400; ảnh `.png` giả (nội dung là
  chữ) → bị chặn theo magic bytes; `.docx` gửi vào luồng OCR → bị từ chối kèm
  giải thích chỉ nhận ảnh.
- **Quá dung lượng**: ảnh > 8 MB → bị chặn kèm thông báo.
- **Hủy xem trước**: sau khi chỉ `extract` + `analyze`, số bài kiểm tra **không
  đổi** và bài đang chọn không bị thay đổi (không ghi gì vào dữ liệu).
- **Giáo viên sửa trước khi lưu**: nội dung/đáp án/điểm sửa trong xem trước được
  lưu **đúng bản đã sửa** (kiểm chứng lại bằng `GET /api/exams/:examId`);
  `points = 2` được giữ, câu khác mặc định 1.
- **Không tự bịa**: gửi lưu 1 câu có `correct = null` → **không lưu câu nào**,
  báo rõ lý do.
- **Lưu & mở lại**: lưu cả đề 8 câu → đọc lại đủ 8 câu.
- **Chống lặp phiên**: dùng lại `sessionId` đã lưu → bị từ chối; `sessionId`
  không tồn tại → báo “hết hạn/không tồn tại”.
- **Bảo vệ**: `status`/`extract`/`analyze` khi ẩn danh → 403.
- **Không ghi ảnh người dùng lên đĩa**: `data/ocr-cache/` chỉ có dữ liệu ngôn
  ngữ tesseract, **không** có file ảnh nào của người dùng.
- Test tự xoá bài nó tạo ra; số bài và bài đang chọn trở về như ban đầu.

### H. Trọng số điểm — 6/6 đạt
`node <tạm>/test-points-scoring.js` (script kiểm chứng, tự phục hồi dữ liệu):

- Đặt trọng số 3 cho câu 1: trả lời **đúng hết** → vẫn **10 điểm**.
- Sai **duy nhất** câu trọng số 3 → **8.6 điểm** (19/22×10) thay vì 9.5 ⇒ trọng
  số **có tác dụng thật**.
- Trả lại trọng số 1 → sai 1 câu còn 19/20 → **9.5 điểm**, **giống hệt** cách
  chấm cũ ⇒ **tương thích ngược**.

### I. Hồi quy các chức năng cũ (sau khi thêm OCR + trọng số)
- `test-render-local.js` **21/21**, `test-render-exam.js` **14/14**
  (nộp đúng hết = 10 điểm, `/api/exam` **không** lộ đáp án),
  `test-render-import.js` **5/5**, `test-render-pins.js` **13/13**,
  `test-import-docx.js` **38/38**.
- `node --check` qua `server.js`, `lib/ocr.js`, `lib/ocr-parse.js`; kiểm tra cú
  pháp toàn bộ `<script>` inline của `teacher.html` và `index.html` → 0 lỗi.

### J. Kiểm thử giao diện OCR thật (Chromium)
Mở `/teacher`, tạo ảnh đề bằng `canvas` ngay trong trình duyệt rồi nạp vào ô
chọn ảnh (đúng luồng người dùng, không gọi tắt API):

- Modal “📷 Nhập đề từ ảnh (OCR)” hiện danh sách ảnh dạng thumbnail kèm nút **✕**
  để bỏ ảnh; nút “Bắt đầu nhận dạng” bật khi có ảnh và hiện nhãn nhà cung cấp
  (“Tesseract (chạy nội bộ) · vie+eng”).
- Bấm nhận dạng → **tự chuyển** sang modal xem trước: 3 thẻ câu hỏi, 3 ô Điểm,
  10 ô đáp án; tóm tắt “Nhận diện 3 câu hỏi (OCR 1 ảnh) · thấy 3 mốc câu hỏi,
  10 đáp án”; nhãn lần lượt `OK`, `OK`, `cần kiểm tra`.
- Chọn đáp án cho câu còn thiếu → nhãn đổi thành `OK` và dòng cảnh báo
  “1 câu cần bạn kiểm tra” **tự ẩn** (đã sửa lỗi này trong lúc kiểm thử).
- Đổi ô Điểm của câu 1 thành 2, bấm **Xác nhận lưu** → tạo bài “TEST-UI-OCR”
  3 câu; đọc lại bằng API thấy `points = 2` và đáp án đúng là đáp án đã chọn
  trong giao diện. **0 lỗi trong Console.** Đã xoá bài test, còn đúng 8 đề gieo
  ban đầu, bài đang chọn không đổi.

---

## 6. `.gitignore` — không commit dữ liệu chạy & thông tin học sinh

```
data/current-session.json
data/student-status.json
data/student-status/
data/results.json
data/results/
data/reports.json
data/progress/
data/pins/
data/default-students.json
data/class-students/
danhsach/
DanhSachLop/
data/ocr-cache/
```
Các file **được** commit làm dữ liệu gieo ban đầu: `data/questions.json`,
`data/exams/*.json`, `data/mau-cau-hoi.*`, `data/de-*.docx` (đều không tải được
qua HTTP). `data/ocr-cache/` chỉ là cache dữ liệu ngôn ngữ tesseract do thư viện
tự tải về — không chứa ảnh người dùng và có thể xoá bất cứ lúc nào.

---

## 7. Checklist sau khi deploy

- [ ] Mở `/api/ping` → trả JSON, HTTP 200.
- [ ] Mở `/` → hiện trang chọn tên.
- [ ] Mở `/teacher` → chuyển tới `/teacher/login`.
- [ ] Đăng nhập sai → báo lỗi; đăng nhập đúng → vào được.
- [ ] Thử tải `https://.../data/questions.json` → **404**.
- [ ] `/teacher` → “Mã PIN học sinh” → tạo PIN, tải Excel.
- [ ] `/teacher` → **Quản lý Bài kiểm tra** → “Nhập Word/Ảnh” → chọn 1 file Word
      mẫu → xem trước → Xác nhận lưu.
- [ ] `/teacher` → **Quản lý Bài kiểm tra** → “📷 Nhập từ ảnh (OCR)” → chọn 1 ảnh
      đề → Bắt đầu nhận dạng → thấy danh sách câu hỏi để sửa.
- [ ] Học sinh chọn tên, nhập PIN đúng → vào làm bài; PIN sai → bị chặn.
- [ ] Mở đề, học sinh nộp bài, giáo viên xem điểm + xuất Excel.
- [ ] Đổi đề thi → câu hỏi/điểm cập nhật đúng.
- [ ] **Restart service trên Render** → kiểm tra lại điểm/PIN vẫn còn (xác nhận
      PostgreSQL đang hoạt động).
- [ ] Đăng xuất → bị đẩy về `/teacher/login`.

---

## 8. Giới hạn & lưu ý còn lại

1. **Socket.IO dùng RAM 1 process** → bắt buộc 1 instance. Muốn nhiều instance
   phải gắn Redis adapter (chưa làm).
2. **Gói Free Render** ngủ sau ~15 phút không truy cập (lần đầu vào chậm) và
   PostgreSQL free có thời hạn.
3. **PIN 4 số** xác thực ở server nhưng học sinh vẫn tự chọn tên trong danh
   sách; PIN chỉ chống chọn nhầm/chọn hộ, **không phải** tài khoản đăng nhập.
4. `socketId` do trình duyệt gửi lên nên về lý thuyết có thể giả mạo (cần biết
   ID phiên khác) — rủi ro thấp.
5. Chỉ `/api/teacher/login` có giới hạn số lần thử; các API khác không giới hạn.
6. `package.json` còn các script `build`, `admin`, `generate-license` trỏ tới
   thư mục không được copy sang bản này (`build-scripts/`, `license/`). Không
   ảnh hưởng `npm start`.
7. **Postgres đã được kiểm thử thật** (mục 5C). Chỉ còn khác biệt về nhà cung
   cấp: Render dùng SSL; code đã bật `ssl` khi host không phải localhost. Nếu
   gặp lỗi kết nối, thêm `?sslmode=require` vào `DATABASE_URL`.
8. Serve `node_modules/katex` cần có `katex` trong dependencies (đã có) để công
   thức toán hiển thị.
9. **OCR**: mặc định tesseract.js chạy trong process Node. Ưu điểm: miễn phí,
   không cần API key, không cần Docker/apt. Đánh đổi: RAM tăng (~150–200 MB cho
   worker) và tốc độ vài giây/ảnh. Với quy mô 1 giáo viên và gói Render 512 MB,
   đủ dùng. Ảnh **chụp điện thoại bị mờ/nghiêng** đọc kém hơn ảnh chụp thẳng, đủ
   sáng — khi đó hệ thống báo “không nhận ra câu hỏi nào” thay vì bịa, hoặc đặt
   `OCR_SPACE_API_KEY` để dùng OCR.space cho chất lượng tốt hơn.
10. Trên Render, `data/ocr-cache/` là ổ đĩa tạm: sau khi service ngủ/khởi động
    lại, dữ liệu ngôn ngữ (~2 MB) sẽ được tải lại một lần. Server **nạp trước
    lúc boot** nên không ảnh hưởng request đầu của giáo viên.
11. OCR **không** nhận dạng hình vẽ/công thức trong ảnh (chỉ đọc chữ). Câu có
    hình vẽ phức tạp nên nhập qua `.docx` hoặc chỉnh tay trong bản xem trước.
