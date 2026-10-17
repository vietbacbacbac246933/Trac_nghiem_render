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
| 3 | `/teacher.html` mở tự do qua static | Chặn, chuyển về `/teacher/login` (đường dẫn được **chuẩn hoá** trước khi so sánh) |
| 4 | File lưu trong `data/` (ổ đĩa Render tạm, mất khi restart) | PostgreSQL khi có `DATABASE_URL`, không thì vẫn dùng file |
| 5 | `/api/settings`, `/api/session` lộ mật khẩu phòng thi | Ẩn với người không phải giáo viên |
| 6 | `/data/*.json` tải trực tiếp được (lộ đáp án) | Chỉ cho tải 2 file mẫu; chặn toàn bộ `.json` |
| 7 | Học sinh chọn tên tự do | Mã PIN riêng cho từng học sinh |
| 8 | Trang phụ `simple.html` chọn tên **không cần PIN** | Đã xoá (cùng `debug.html`, `test.html`) |
| 9 | Thiếu khai báo gói `jszip`, `xml-js` | Thêm vào `package.json` |
| 10 | Không bắt tín hiệu tắt của Render | Bắt `SIGTERM`/`SIGINT`, ghi nốt dữ liệu rồi thoát |
| 11 | Nhập đề thủ công tốn thời gian | Thêm nhập đề từ **Word (.docx) / ảnh** và từ **ảnh bằng OCR** (tesseract.js) — có bản xem trước cho sửa, không tự bịa đáp án |
| 12 | Đề in từ Word thường **gạch chân** đáp án đúng (không dùng dấu `*`) | Nhận diện **đáp án gạch chân**: với Word đọc thẻ `<u>`; với ảnh thì dò **điểm ảnh** (đoạn mực dài ngay dưới chân chữ) — xem mục 5.G/5.K |
| 13 | Đề thực tế in **2 cột** (nhiều đáp án trên 1 dòng) và **“Câu N.” in đậm** ⇒ câu bị “lồng” câu khác, nhiều câu bị đánh dấu *cần kiểm tra*, **đáp án gạch chân bị gán sai chữ cái**, bản xem trước hiện cả thẻ `<strong>` | Phân tích lại theo **văn bản thuần**: tách nhiều đáp án trên cùng dòng, bỏ tiền tố kể cả khi in đậm/gạch chân, nhận `PHẦN I/II/III` (Phần II đúng/sai ⇒ câu **Đúng/Sai**, gạch chân = phát biểu Đúng), bỏ định dạng trang trí khỏi nội dung lưu — xem mục 5.L |
| 14 | Nhập file dài (100+ câu) phải cuộn tìm câu lỗi | Thêm **bộ lọc** trong bản xem trước: *Tất cả (N) / ✓ Đọc hoàn hảo (n) / ⚠ Cần kiểm tra (n)*, số đếm cập nhật ngay khi sửa — xem mục 5.M |

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
| `tests/test-import-docx.js` | Test DOCX hợp lệ, thiếu đáp án, **đáp án gạch chân trong Word**, sai định dạng, file giả, docx hỏng, ảnh, quá dung lượng, chặn ẩn danh, chống lưu lặp. |

### File mới (tính năng nhập đề từ ẢNH bằng OCR)
| File | Vai trò |
|---|---|
| `lib/ocr.js` | Trích xuất chữ từ ảnh. Mặc định **tesseract.js** (WASM, chạy trong tiến trình Node, miễn phí, không cần API key, không cần cài gói hệ thống nên chạy được trên Render Node thuần); tuỳ chọn **OCR.space** qua biến môi trường `OCR_SPACE_API_KEY`. Chỉ nhận `Buffer` trong RAM; xếp hàng tuần tự để giới hạn RAM. |
| `lib/ocr-parse.js` | Chuẩn hoá văn bản OCR (`Cau 1`→`Câu 1`, `A.4`→`A. 4`, gộp dòng, bỏ tiền tố rác/số trang) và đánh giá “có giống đề thi không” để báo lỗi khi ảnh mờ. |
| `lib/underline.js` | Dò **đáp án đúng bị GẠCH CHÂN** trong ảnh. Dùng toạ độ dòng chữ của tesseract + đọc trực tiếp điểm ảnh (`pngjs` cho PNG, `jpeg-js` cho JPEG): nhị phân bằng Otsu (tự nhận nền sáng/tối), tìm đoạn mực **dài và mảnh nằm ngay dưới đường chân chữ (baseline)** trong dòng đáp án → chèn `*` vào cuối dòng để phần phân tích phía sau hiểu là đáp án đúng. Không giải mã được ảnh thì trả về “không có gạch chân” (an toàn). |
| `tests/test-ocr-import.js` | Test OCR (84 trường hợp): ảnh rõ, nhiều câu, ảnh mờ/không đọc được, câu thiếu đáp án, **đáp án gạch chân (chỉ chữ cái / cả dòng)**, sai định dạng, quá dung lượng, sửa trước khi lưu, hủy không tạo dữ liệu, lưu rồi mở lại, chống lặp phiên, chặn ẩn danh, không ghi ảnh người dùng lên đĩa. |
| `tests/fixtures/*.png` + `make-fixtures.ps1` | Ảnh đề mẫu (4 câu, 8 câu, **đáp án gạch chân**, ảnh mờ) và script GDI+ tạo lại. |

### File sửa
| File | Nội dung chính |
|---|---|
| `server.js` | PORT động; trust proxy; guard `/teacher.html`; route `/teacher`, `/teacher/login`, `/api/teacher/login|logout|session`; thay `isLocalhost`→`isTeacher` (49 chỗ); toàn bộ đọc/ghi dữ liệu chuyển qua `DATA.*`; ẩn `examPassword`; quản lý PIN + `/api/student-pins*`; `/api/select-student` đòi PIN; bootstrap bất đồng bộ + shutdown. **Thêm:** `/api/import/preview`, `/api/import/confirm`, `GET /api/exams/:examId`; multer riêng có giới hạn + lọc định dạng; `parseQuestionsFromHtml` chế độ `trackReview` (đánh dấu câu cần kiểm tra, không tự gán đáp án). **Thêm (OCR):** `/api/ocr/extract`, `/api/ocr/analyze`, `/api/ocr/status`; trường `points` (trọng số) trong chuẩn hoá câu hỏi + công thức chấm điểm quy về thang 10 theo trọng số (không có `points` thì y như cũ); nạp trước OCR lúc khởi động và giải phóng worker khi tắt. **Thêm (gạch chân):** nạp `lib/underline.js` — dò gạch chân trong `/api/ocr/extract`, trả `underlined` (số đáp án suy ra từ gạch chân); `styleMap: "u => u"` khi đọc Word để giữ thẻ `<u>`, `hasUnderlineMarker()` coi `<u>` trong **dòng đáp án** là đáp án đúng, `stripOptionPrefix()`/`removeCorrectMarkers()` bỏ `<u>` khỏi nội dung đáp án. |
| `package.json` | Thêm `jszip`, `xml-js`, `pg`, `tesseract.js`, `pngjs`, `jpeg-js`; `engines.node >= 18`; thêm script `test:import`, `test:ocr`. |
| `public/teacher.html` | Nút Đăng xuất; tự chuyển trang khi 401; nút + hộp thoại “Mã PIN học sinh” (xem/tạo lại/tải Excel). **Thêm:** nút “Nhập Word/Ảnh” + modal xem trước cho sửa (nội dung, đáp án, loại câu, chọn đáp án đúng) và chọn nơi lưu. **Thêm (OCR):** nút “📷 Nhập từ ảnh (OCR)”, modal chọn/xoá ảnh (thumbnail + nút ✕), xem văn bản OCR để đối chiếu, và ô **Điểm** từng câu trong bản xem trước. **Thêm (gạch chân):** dòng thông báo “🖍 Đã nhận ra N đáp án được gạch chân…” trên bản xem trước OCR. |
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

### E. Nhập đề từ Word/Ảnh — 61/61 đạt
`node tests/test-import-docx.js` (server cổng 3999, `TEACHER_PASSWORD=test123`):

- **DOCX hợp lệ**: `mau-cau-hoi`/đề tự sinh → nhận đúng 2 câu, đúng đáp án `*`,
  câu 1 không bị đánh dấu.
- **Đáp án GẠCH CHÂN trong Word** (mục 12, 18 trường hợp): đề có đáp án gạch chân
  chỉ chữ cái (`D.`) → đáp án D; gạch chân cả dòng (`D. 11`) → đáp án D; câu
  **không** gạch chân → `correct = null` + “cần kiểm tra”; gạch chân ở **dòng câu
  hỏi** → **không** bị hiểu là đáp án. Nội dung đáp án lưu ra đã **bỏ thẻ `<u>`**
  và **bỏ chữ cái `D.` ở đầu**; lưu rồi đọc lại đúng đáp án.
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

### G. Nhập đề từ ẢNH bằng OCR — 84/84 đạt
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
- **Đáp án GẠCH CHÂN trong ảnh** (`de-thi-gach-chan.png`, mục 18 — 15 trường hợp):
  extract báo `underlined = 3`; câu 1 gạch chân **chỉ chữ cái `D.`** → đáp án D (3);
  câu 2 gạch chân **chỉ `B.`** → đáp án B (1); câu 3 gạch chân **cả dòng `D. 11`**
  → đáp án D (3); câu 4 **không** gạch chân → `correct = null` + “cần kiểm tra”.
  Dấu `*` chèn tạm **không** lọt vào nội dung đáp án lưu ra; lưu 3 câu rồi đọc lại
  đúng đáp án. Đo thực tế: dòng gạch chân có **đoạn mực dài 28–168 px**, còn nét
  chữ/đuôi chữ chỉ **0–10 px** ⇒ ngưỡng `max(16, 0.55×chiều cao dòng)` tách bạch
  hoàn toàn, **không** báo nhầm dòng nào.
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

### I. Hồi quy các chức năng cũ (sau khi thêm OCR + trọng số + gạch chân + tách đề 2 cột)
- `test-render-local.js` **21/21**, `test-render-exam.js` **14/14**
  (nộp đúng hết = 10 điểm, `/api/exam` **không** lộ đáp án),
  `test-render-import.js` **5/5**, `test-render-pins.js` **13/13**,
  `test-import-docx.js` **83/83**, `test-ocr-import.js` **84/84** ⇒ **226/226**.
- **Guard `/teacher.html` được siết lại**: trước đây so sánh thô `req.path` nên
  `//teacher.html` và `/%74eacher.html` **lọt qua** rồi được `express.static` trả
  về nguyên trang giáo viên. Nay đường dẫn được giải mã + gộp `/` + bỏ `/./` +
  không phân biệt HOA/thường trước khi so sánh ⇒ **5 trường hợp chặn-đúng** đã
  được thêm vào test (vẫn 302 cho người chưa đăng nhập, 200 cho giáo viên đã
  đăng nhập).
- Kiểm tra 7 file `.docx` mẫu sẵn trong `data/` (đọc trực tiếp `word/document.xml`)
  → **không file nào** dùng gạch chân ⇒ bật `styleMap "u => u"` **không** làm đổi
  kết quả của các đề mẫu cũ.
- `node --check` qua `server.js`, `lib/ocr.js`, `lib/ocr-parse.js`, `lib/underline.js`;
  kiểm tra cú pháp toàn bộ `<script>` inline của `teacher.html` và `index.html` → 0 lỗi.

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

### K. Kiểm thử giao diện GẠCH CHÂN thật (Chromium) — đã sửa 1 lỗi tìm được
Cũng bằng cách vẽ đề trong trình duyệt (`canvas`) rồi nạp vào ô chọn ảnh, nhưng
lần này **đáp án đúng được gạch chân** (câu 1 gạch chân chữ cái `B.`, câu 2 gạch
chân `C.`, câu 3 gạch chân cả dòng `D. Mười một`), **không** dùng dấu `*`:

- Lần chạy đầu chỉ nhận ra **2/3** đáp án. Bật `OCR_DEBUG=1` để in số đo từng
  dòng, phát hiện nguyên nhân: gạch chân do công cụ khác vẽ ra nằm **thấp hơn**
  gạch chân của Word, mà cửa sổ dò ban đầu chỉ xuống dưới baseline ~6–8 px.
- **Sửa:** mở rộng cửa sổ dò xuống **sát dòng chữ kế tiếp** (không lấn sang dòng
  dưới); vẫn dựa vào **độ dài đoạn mực** làm yếu tố lọc chính nên không sinh báo
  nhầm. Thêm log gỡ lỗi có kiểm soát bằng `OCR_DEBUG=1`.
- Chạy lại: nhận đủ **3/3**, dòng tóm tắt hiện “🖍 Đã nhận ra **3** đáp án được
  gạch chân trong ảnh và tự chọn sẵn”, cả 3 câu đều nhãn `OK`, **0** câu cần kiểm tra.
- Bấm **Xác nhận lưu** → tạo bài “TEST-UI-GACH-CHAN”; đọc lại bằng API thấy đáp án
  đúng lần lượt **B, C, D** (đúng như ảnh). **0 lỗi trong Console.** Đã xoá bài
  test, còn đúng 8 đề, bài đang chọn không đổi, `data/questions.json` khôi phục 20 câu.

### L. Sửa lỗi “câu bị lồng nhau” + tách đề in 2 cột — 22 trường hợp mới (thêm vào test A: 61 → 83)

**Lỗi giáo viên báo** (đối chiếu file `THỰC-HÀNH-LỊCH-SỬ-12_-BÀI_12345.docx`):
thẻ câu thứ **71** trong bản xem trước hiện nội dung `Câu 80. Từ năm 2015 …` nên
trông như câu 71 bị “lồng” câu 80. Truy vết trên file thật:

1. Word **in đậm** tiền tố (`<w:b>` cho `"Câu 80"` và `"."`) nên HTML là
   `<strong>Câu 80</strong><strong>.</strong> Từ năm 2015 …`; hàm bỏ tiền tố cũ chạy
   regex trên **chuỗi HTML** nên không khớp ⇒ **tiền tố còn nguyên trong nội dung**.
   Vì số thứ tự trên thẻ là **vị trí** (71) còn chữ trong ô là “Câu 80” nên nhìn
   như lồng nhau. Cùng nguyên nhân này, chữ cái đáp án bị lặp (`<strong>D</strong>.` →
   `D. D. Sự cạnh tranh…`) khi đáp án đúng vừa **in đậm** vừa **gạch chân**.
2. Word trình bày **2 cột bằng khoảng trắng** trong *cùng một đoạn*:
   `A. Campuchia        B. Mianma        C. Brunây        D. Malaixia`. Parser cũ coi
   **cả dòng là 1 đáp án** ⇒ câu bị đánh dấu *cần kiểm tra* (6 câu), và nguy hiểm hơn:
   **gạch chân nằm ở B/C/D nhưng bị gán cho đáp án đầu dòng** (Câu 77 lưu đáp án C
   trong khi đề gạch chân D).
3. Dòng `Phần II. Câu trắc nghiệm đúng sai. …` không được nhận là **tiêu đề phần**
   ⇒ sinh lý do “đoạn chưa nhận dạng được” cho câu liền trước; và **Phần II bị đọc
   thành câu 1 đáp án** với đáp án *đoán* theo gạch chân cuối cùng (sai loại câu).

**Đã sửa** (`server.js`):

- Bỏ tiền tố trên **văn bản thuần** rồi cắt đúng vị trí trong HTML (`mapHtmlText`,
  `cutHtmlPrefix`, `balanceHtml`): xử lý được mọi kiểu bọc thẻ của Word
  (`<strong>Câu 1.</strong>`, `<u>A</u><strong>.</strong>`, gạch chân cả dòng…);
  sau khi cắt, thẻ lệch được tự cân bằng.
- `splitInlineOptions`: tách đoạn có **nhiều nhãn đáp án liên tiếp** (A, B, C, D)
  thành từng đáp án; mỗi đáp án **giữ lại đúng thẻ định dạng đang bao quanh nó**
  (`openTagPrefixAt`) nên dấu gạch chân ở B/C/D vẫn nhận đúng **chữ cái của nó**.
- Nhận **tiêu đề phần** `PHẦN I/II/III…`: chốt câu đang dựng, không tính là nội dung;
  `Phần II. Câu trắc nghiệm đúng sai` ⇒ các câu sau là **Đúng/Sai**, **gạch chân dưới
  một phát biểu = phát biểu ĐÚNG**; không có dấu hiệu nào ⇒ để trống + đánh dấu cần
  kiểm tra (không tự bịa).
- Bỏ **định dạng trang trí** (b/strong/i/em/u/span/font/mark) khỏi nội dung câu hỏi
  và đáp án trước khi lưu (giữ ảnh, `<pre>`/code, `<sub>`/`<sup>`, token
  `[[IMG:n]]`/`MATHPLACEHOLDER…`) ⇒ bản xem trước đọc được như văn bản bình thường.
- Không để một dòng đáp án **rỗng** ghi đè nội dung đã có.

**Kết quả trên đúng file giáo viên gửi** (qua `/api/import/preview`):

| Trước | Sau |
|---|---|
| 107 câu, **7 câu** cần kiểm tra, có câu nội dung còn `Câu 80.`, đáp án lặp chữ cái `D. D.`, đáp án gán sai (Câu 77 = C thay vì D), Phần II là câu 1 đáp án | 107 câu, **0 câu** cần kiểm tra, không còn tiền tố/thẻ HTML/khoảng trắng cột, **87 câu 1 đáp án + 20 câu Đúng/Sai** (Phần II đúng), đáp án gạch chân đúng chữ cái (B, C, D…), Phần II `correctTF` = Đ/S theo gạch chân (ví dụ câu 1 Phần II: `[Đ,S,S,Đ]`) |

**Test tự động** — thêm **mục 13** trong `tests/test-import-docx.js` (**22 trường
hợp mới**, tổng **83/83**): dựng file `.docx` ngay trong test (`buildCompactTwoColumnDocx`)
đúng kiểu đề trên — *2 đáp án trên 1 dòng*, *4 đáp án trên 1 dòng*, *“Câu N.” in đậm*,
*gạch chân nằm ở B / C / D*, *Phần II. Câu trắc nghiệm đúng sai*. Kiểm tra: bỏ sạch
tiền tố, không còn thẻ HTML trong ô sửa, tách đúng 2 → 4 đáp án, **đáp án gạch chân
gán đúng chữ cái**, Phần II ra loại `truefalse` với `correctTF` đúng, không có lý do
“cần kiểm tra” giả, lưu 5/5 câu và đọc lại đúng cả câu Đúng/Sai.

### M. Kiểm thử giao diện BỘ LỌC thật (Chromium)

Trên `/teacher` (đã đăng nhập), mở **Quản lý Bài kiểm tra → Nhập Word/Ảnh** và nạp
file thật qua `DataTransfer` + sự kiện `change` (đúng luồng người dùng):

- File nhỏ (1 câu có đáp án gạch chân + 1 câu không có đáp án): thanh lọc hiện
  **“Tất cả (2) · ✓ Đọc hoàn hảo (1) · ⚠ Cần kiểm tra (1)”**. Bấm **⚠ Cần kiểm tra**
  → chỉ còn thẻ `câu 2` (nhãn *cần kiểm tra*); bấm **✓ Đọc hoàn hảo** → chỉ còn
  `câu 1` (nhãn *OK*); bấm **Tất cả** → đủ 2 thẻ. Nút đang chọn đổi màu (nền cam,
  chữ trắng, đậm), các nút còn lại trắng/xám.
- **Đúng file giáo viên gửi**: bản xem trước hiện **107** thẻ và **“Tất cả (107) ·
  ✓ Đọc hoàn hảo (107) · ⚠ Cần kiểm tra (0)”**. Thẻ thứ **71** (đúng chỗ giáo viên
  phản ánh) nay hiện `Từ năm 2015 đến nay, Cộng đồng ASEAN …` — **không còn “Câu 80.”**,
  nhãn `OK`, 4 đáp án sạch (tiền tệ / đối ngoại / kinh tế / quân sự) và **tự chọn sẵn
  đáp án C (kinh tế)**. Quét toàn bộ 107×2 ô sửa: **0 ô nào còn lộ thẻ HTML**
  (`<strong>`…). **87 thẻ** dùng nút chọn 1 đáp án, **20 thẻ** dùng ô chọn Đúng/Sai
  (ví dụ thẻ 88: Đúng / Sai / Sai / Đúng — đúng như gạch chân trong file).
- **0 lỗi JavaScript** trong Console (chỉ có log Socket.IO ngắt kết nối do tiến
  trình server được khởi động lại giữa lúc kiểm thử). Bản xem trước được **huỷ**
  (không lưu gì); 2 file `.docx` dùng để thử đã xoá khỏi `public/`.

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
