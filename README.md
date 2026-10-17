# Trắc Nghiệm (bản chạy online trên Render)

Phần mềm thi trắc nghiệm dành cho giáo viên và học sinh, đã được chỉnh từ bản
chạy LAN để có thể triển khai trên Internet (Render). Kiến trúc gốc được giữ
nguyên (Node.js + Express + Socket.IO, giao diện HTML thuần).

## 1. Thay đổi so với bản LAN

| Hạng mục | Bản LAN (gốc) | Bản online (repo này) |
|---|---|---|
| Lưu trữ | File JSON trong `data/` | PostgreSQL nếu có `DATABASE_URL`, ngược lại vẫn dùng file |
| Cổng | Cố định 3456 | `process.env.PORT` (Render tự cấp) |
| Trang giáo viên | `isLocalhost` (chỉ local) | Đăng nhập bằng `TEACHER_PASSWORD` + cookie ký HMAC |
| Danh sách học sinh | Có thể truy cập tự do | Có mã PIN riêng cho từng học sinh |
| `data/*.json` | Phục vụ tĩnh qua `/data` (lộ đáp án) | Chỉ cho tải 2 file mẫu; chặn mọi `.json` |
| `/api/settings`, `/api/session` | Trả cả mật khẩu phòng thi | Ẩn mật khẩu với người không phải giáo viên |

## 2. Biến môi trường

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `PORT` | Không (Render tự cấp) | Cổng server lắng nghe |
| `TEACHER_PASSWORD` | **Có** (khi online) | Mật khẩu đăng nhập giáo viên |
| `SESSION_SECRET` | Nên có | Khóa ký cookie; Render tự sinh nếu dùng `render.yaml` |
| `DATABASE_URL` | **Có** (khi online) | Chuỗi kết nối PostgreSQL |
| `PG_POOL_MAX` | Không | Số kết nối tối đa (mặc định 5) |
| `NODE_ENV` | Không | `production` khi deploy |
| `OCR_PROVIDER` | Không | `auto` (mặc định) \| `tesseract` \| `ocrspace` |
| `OCR_LANGS` | Không | Ngôn ngữ OCR, mặc định `vie+eng` |
| `OCR_SPACE_API_KEY` | Không | Khoá OCR.space (chỉ khi muốn dùng `ocrspace`) |
| `OCR_DEBUG` | Không | Đặt `1` để in tiến trình OCR + kết quả dò gạch chân theo từng dòng ra log (khi cần gỡ lỗi) |

Xem `.env.example`.

**Về OCR:** mặc định dùng **tesseract.js** (chạy ngay trong tiến trình Node,
WASM) nên **không cần API key, không cần cài thêm gói hệ thống** — hợp với
Render ở chế độ Node thuần. Nếu muốn chất lượng tốt hơn với ảnh chụp bằng điện
thoại, đặt `OCR_SPACE_API_KEY` (OCR.space có gói miễn phí) và hệ thống sẽ tự
chuyển sang dùng OCR.space. **Không khoá nào được ghi trong mã nguồn.**

Chức năng dò **đáp án gạch chân** trong ảnh dùng thêm 2 thư viện **thuần
JavaScript** (không cần biên dịch, cài qua `npm install` như bình thường):
`pngjs` (đọc ảnh PNG) và `jpeg-js` (đọc ảnh JPG).

## 3. Chạy thử ở máy (chế độ file, không cần Postgres)

```powershell
npm install
$env:TEACHER_PASSWORD = "mat-khau-cua-ban"
$env:PORT = "3456"
node server.js
```

- Học sinh: http://localhost:3456/
- Giáo viên: http://localhost:3456/teacher (đăng nhập bằng `TEACHER_PASSWORD`)
- Kiểm tra sức khỏe: http://localhost:3456/api/ping

## 4. Triển khai trên Render

### Cách A — Dùng Blueprint (`render.yaml`)

1. Đẩy mã nguồn lên GitHub (repo riêng, **không** kèm `.env`).
2. Render Dashboard → **New** → **Blueprint** → chọn repo.
3. Render đọc `render.yaml`, tạo Web Service + PostgreSQL.
4. Khi được hỏi, nhập `TEACHER_PASSWORD`.
5. Bấm **Apply**. Chờ build xong, mở URL dạng `https://...onrender.com`.

### Cách B — Tạo tay

1. **New** → **PostgreSQL**: tạo DB (Free). Lấy **Internal Database URL**.
2. **New** → **Web Service** → chọn repo.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/api/ping`
3. Thêm biến môi trường: `TEACHER_PASSWORD`, `DATABASE_URL`,
   `SESSION_SECRET` (Render có nút generate), `NODE_VERSION=18`.
4. Deploy.

### Sau khi deploy
- Lần đầu chạy, nếu bảng `quiz_kv` trống, server tự nạp (seed) câu hỏi và đề
  thi từ `data/` vào PostgreSQL.
- Vào `/teacher`, đăng nhập, bấm **“Mã PIN học sinh”** để tạo và tải mã PIN
  cho lớp, phát cho học sinh.
- **Chỉ chạy 1 instance** (Socket.IO dùng RAM của process).

## 5. Luồng sử dụng

1. Giáo viên đăng nhập `/teacher`.
2. Chọn lớp + bài kiểm tra, mở bài thi.
3. Học sinh mở `/`, chọn tên mình, nhập **mã PIN** do giáo viên phát.
4. Học sinh làm bài và nộp. Giáo viên xem điểm, xuất Excel.

### Nhập đề thi từ Word (.docx) và ảnh

Trong **Quản lý Bài kiểm tra** → nút **“Nhập Word/Ảnh”**:

1. Chọn 1 file `.docx` và/hoặc nhiều file ảnh (`.png .jpg .jpeg .gif .bmp .webp`).
2. Server kiểm tra phần mở rộng, MIME type, **magic bytes** và dung lượng.
3. Server trích văn bản (kèm công thức toán và ảnh nhúng) rồi phân tích thành
   câu hỏi / đáp án.
4. Hiện **bản xem trước cho sửa được**: nội dung câu, đáp án, chọn đáp án đúng,
   đổi loại câu (một đáp án / nhiều đáp án / Đúng–Sai), thêm–bớt đáp án, **điểm
   (trọng số)** từng câu, bật/tắt từng câu. Có **bộ lọc nhanh** *Tất cả / ✓ Đọc
   hoàn hảo / ⚠ Cần kiểm tra* (xem mục *Lọc nhanh câu hỏi trong bản xem trước*).
5. Giáo viên bấm **Xác nhận lưu** thì mới ghi dữ liệu, vào **bài mới** hoặc
   **bài đang soạn** (tự chọn).

Nguyên tắc:

- **Đáp án đúng** được nhận ra khi trong file có dấu hiệu rõ ràng: dấu `*` sau
  đáp án, `[x]`, `(đúng)`, hoặc **đáp án được GẠCH CHÂN** (kiểu rất phổ biến ở đề
  in từ Word: gạch chân chỉ chữ cái `D.`, hoặc gạch chân cả dòng). Gạch chân chỉ
  được xét **trong dòng đáp án** — gạch chân ở dòng câu hỏi không bị hiểu thành
  đáp án; sau khi nhận diện, gạch chân được bỏ khỏi nội dung đáp án lưu lại.
- **Không tự bịa dữ liệu.** Câu thiếu đáp án / thiếu nội dung / không xác định
  được ranh giới sẽ bị gắn nhãn *“cần kiểm tra”* kèm lý do, chứ không tự gán
  đáp án A. Khi bấm lưu, câu chưa hợp lệ sẽ bị **bỏ qua** và báo rõ lý do.
- **File ảnh rời** ở luồng này: mỗi ảnh tạo 1 câu có sẵn hình, **để trống** nội
  dung/đáp án và đánh dấu cần kiểm tra (giáo viên tự nhập chữ). Muốn máy đọc chữ
  từ ảnh thì dùng nút **“📷 Nhập từ ảnh (OCR)”** — xem mục dưới.
- **Ảnh nhúng trong `.docx`** được giữ và gắn vào đúng câu hỏi.
- **Không lưu file tạm vô thời hạn:** file được xử lý trong RAM; ảnh chỉ được
  giữ trong “phiên xem trước” 30 phút rồi tự xoá. Không ghi file tạm ra đĩa và
  **không bao giờ thực thi file tải lên**.
- Giới hạn: `.docx` ≤ 15 MB, mỗi ảnh ≤ 8 MB, tổng ≤ 25 MB, tối đa 30 ảnh/lần.

Các kiểu trình bày “khó” đã được xử lý riêng (rút ra từ đề thực tế của giáo viên):

- **Nhiều đáp án trên CÙNG một dòng** (đề in 2 cột, các cột cách nhau bằng khoảng
  trắng, ví dụ `A. Campuchia      B. Mianma` hoặc cả `A… B… C… D…` trên 1 dòng):
  server **tách thành từng đáp án riêng** đúng thứ tự A, B, C, D. Nhờ vậy đáp án
  gạch chân nằm ở B/C/D vẫn được gán **đúng chữ cái** (trước đây cả dòng bị coi là
  1 đáp án nên câu bị đánh dấu “cần kiểm tra”, và gạch chân ở B bị tính nhầm cho A).
- **“Câu N.” (hoặc “A.”) bị IN ĐẬM / GẠCH CHÂN trong Word**: việc bỏ tiền tố được
  làm trên **văn bản thuần** rồi cắt đúng vị trí trong HTML, nên tiền tố luôn được
  bỏ sạch. Trước đây, khi “Câu 80.” bị in đậm thì nó **còn sót lại trong nội dung
  câu hỏi**, làm câu 71 (thứ tự thứ 71 trong bản xem trước) trông như bị “lồng” câu 80.
- **Tiêu đề phần** `PHẦN I/II/III…` được nhận là **mốc chuyển phần**, không phải nội
  dung câu hỏi (trước đây nó tạo lý do “đoạn chưa nhận dạng được” cho câu liền trước).
  Riêng **“Phần II. Câu trắc nghiệm đúng sai”** → các câu sau được đặt sẵn loại
  **Đúng/Sai** với đáp án từng phát biểu a) b) c) d); **gạch chân dưới một phát biểu
  = phát biểu ĐÚNG** (cùng quy ước với gạch chân ở phần I). Không có dấu hiệu nào thì
  các phát biểu được để trống và câu bị đánh dấu *cần kiểm tra*.
- **Định dạng trang trí** (in đậm / nghiêng / gạch chân / màu chữ) bị **bỏ khỏi nội
  dung lưu** để bản xem trước đọc được như văn bản bình thường (trước đây ô sửa hiện
  ra cả thẻ `<strong>`). Ảnh nhúng, khối code và công thức toán vẫn được giữ nguyên.

### Lọc nhanh câu hỏi trong bản xem trước

Ngay trên bản xem trước có 3 nút lọc theo trạng thái **tính tại thời điểm đang xem**:

- **Tất cả (N)** — xem toàn bộ như trước.
- **✓ Đọc hoàn hảo (n)** — chỉ hiện các câu đã có nội dung, ≥ 2 đáp án và **đã xác
  định được đáp án đúng** (không có lý do cần kiểm tra nào).
- **⚠ Cần kiểm tra (n)** — chỉ hiện các câu còn thiếu nội dung / thiếu đáp án / chưa
  xác định đáp án; nếu không còn câu nào thì báo “🎉 Không có câu nào cần kiểm tra”.

Số trên nút được cập nhật ngay khi giáo viên sửa (chọn đáp án, sửa nội dung…), nên
có thể lọc “Cần kiểm tra” rồi sửa lần lượt cho đến khi về 0. Đổi bộ lọc **không**
làm mất nội dung đã sửa và **không** tự lưu gì.

### Nhập đề từ ẢNH bằng OCR

Trong **Quản lý Bài kiểm tra** → nút **“📷 Nhập từ ảnh (OCR)”**:

1. **Chọn ảnh**: chọn nhiều ảnh PNG/JPG. Danh sách ảnh hiện thumbnail, hover vào
   ảnh bấm **✕** để bỏ ảnh trước khi xử lý (chưa gửi gì lên server).
2. Bấm **Bắt đầu nhận dạng** → server **đọc chữ (OCR)** trong từng ảnh, xong thì
   chuẩn hoá văn bản và **tách thành câu hỏi / đáp án A-B-C-D**.
3. Chuyển sang **bản xem trước cho sửa được** giống luồng Word/Ảnh. Mở mục
   *“Xem văn bản OCR đọc được”* (ở bước chọn ảnh) để **đối chiếu với ảnh gốc**.
4. Chỉ khi giáo viên bấm **Xác nhận lưu** thì mới ghi dữ liệu.

Nguyên tắc riêng cho OCR:

- **Không đoán đáp án.** Đáp án đúng chỉ được lấy khi ảnh có dấu hiệu rõ ràng
  (`*` sau đáp án, `[x]`, `(đúng)`), ví dụ `B. Hà Nội *`, **hoặc chữ cái đáp án bị
  GẠCH CHÂN trong ảnh** (ví dụ dưới `D.` có gạch chân). Với gạch chân, server đọc
  trực tiếp điểm ảnh: tìm một **đoạn mực dài, mảnh, nằm ngay dưới đường chân chữ
  (baseline)** trong dòng đáp án — nét chữ và đuôi chữ (g, y, ạ…) chỉ tạo đoạn
  ngắn nên không bị nhầm. Chỉ xét dòng bắt đầu bằng `A.`/`B.`/`C.`/`D.`. Nếu **không**
  ghi đáp án đúng, câu đó có `correct = null` và bị đánh dấu **cần kiểm tra**; nếu
  giáo viên cố lưu thì câu đó bị **bỏ qua** chứ không tự gán bừa. Số đáp án nhận ra
  nhờ gạch chân được báo ngay trên bản xem trước để giáo viên đối chiếu với ảnh.
- **Ảnh mờ / không có chữ**: hệ thống báo rõ *“OCR không nhận ra câu hỏi nào”* và
  hiện văn bản đọc được để giáo viên biết cần chụp lại ảnh rõ hơn.
- **Tách bước rõ ràng**: *chọn ảnh → OCR → phân tích câu hỏi → xem trước → xác
  nhận lưu*; bước OCR và phân tích **không** ghi gì vào dữ liệu.
- **Không lưu ảnh lên đĩa**: ảnh nằm trong RAM (`multer.memoryStorage()`); cache
  `data/ocr-cache/` chỉ chứa **dữ liệu ngôn ngữ công khai** của tesseract, không
  chứa ảnh người dùng.
- Lần chạy đầu, tesseract tải dữ liệu ngôn ngữ (~2 MB cho `vie`) về
  `data/ocr-cache/`. Server **tự nạp trước ngay khi khởi động** nên lần OCR đầu
  của giáo viên không bị chậm. Trên Render, ổ đĩa là tạm nên sau khi service ngủ
  dậy sẽ tải lại một lần.

**Điểm (trọng số) từng câu:** ô `Điểm` trong bản xem trước là **trọng số** (mặc
định 1). Điểm bài vẫn quy về thang 10 theo tỉ lệ trọng số:
`điểm = (Σ điểm từng câu × trọng số) / (Σ trọng số) × 10`. Nếu mọi câu đều để
trọng số 1 thì **kết quả giống hệt trước đây** (tương thích ngược hoàn toàn).

API mới (đều yêu cầu đăng nhập giáo viên):

| API | Việc |
|---|---|
| `POST /api/import/preview` | Nhận file, kiểm tra, phân tích, trả bản xem trước + `sessionId` |
| `POST /api/import/confirm` | Lưu câu hỏi sau khi giáo viên xác nhận |
| `GET /api/exams/:examId` | Đọc nội dung 1 bài đã lưu (chỉ đọc) |
| `GET /api/ocr/status` | Cho biết OCR đã sẵn sàng chưa, đang dùng nhà cung cấp nào |
| `POST /api/ocr/extract` | Nhận ảnh, kiểm tra, **OCR** → trả văn bản + `sessionId` (chưa lưu câu hỏi) |
| `POST /api/ocr/analyze` | `{ sessionId }` → phân tích văn bản OCR thành câu hỏi xem trước |

## 6. Giới hạn đã biết

- **Socket.IO lưu trong RAM** → bắt buộc 1 instance. Muốn nhiều instance phải
  gắn Redis adapter (chưa làm).
- **Gói Free của Render** sẽ ngủ sau ~15 phút không dùng (lần đầu vào chậm) và
  Postgres free có thời hạn.
- Mã PIN học sinh là 4 chữ số, xác thực phía server nhưng **học sinh tự chọn
  tên** trong danh sách; PIN chỉ ngăn chọn nhầm/chọn hộ, không phải tài khoản
  đăng nhập đầy đủ.
- `socketId` do trình duyệt gửi lên nên về lý thuyết có thể giả mạo (rủi ro
  thấp, cần biết ID của phiên khác).
- Chưa giới hạn tần suất ở mọi API (chỉ có ở đăng nhập giáo viên).
- **Dò gạch chân chỉ chạy với tesseract** (nhà cung cấp mặc định), vì cần toạ độ
  từng dòng chữ do tesseract trả về. Nếu đặt `OCR_SPACE_API_KEY` (provider
  `ocrspace`) thì OCR.space chỉ trả về chữ, **không** dò được gạch chân — khi đó
  đáp án đúng vẫn phải dựa vào `*`/`[x]`/`(đúng)` và giáo viên tự chọn.

## 7. Cấu trúc thư mục

```
server.js            # Toàn bộ server (giữ nguyên nghiệp vụ bản LAN)
lib/datastore.js     # Lớp lưu trữ PostgreSQL / file
lib/auth.js          # Xác thực giáo viên (cookie ký HMAC)
lib/file-validate.js # Kiểm tra định dạng/dung lượng file nhập đề
lib/import-sessions.js # Phiên xem trước khi nhập đề (RAM, tự hết hạn)
lib/ocr.js           # Trích xuất chữ từ ảnh (tesseract.js / OCR.space)
lib/ocr-parse.js     # Chuẩn hoá văn bản OCR trước khi phân tích câu hỏi
lib/underline.js     # Dò đáp án GẠCH CHÂN trong ảnh (đọc điểm ảnh, không cần OCR thêm)
public/              # Giao diện học sinh, giáo viên, trang đăng nhập
data/                # Dữ liệu gieo ban đầu (câu hỏi, đề thi, file mẫu)
data/ocr-cache/      # Cache dữ liệu ngôn ngữ OCR (tự sinh, không commit)
tests/               # Test (chạy tay, cần server đang chạy)
tests/fixtures/      # Ảnh mẫu cho test OCR (+ make-fixtures.ps1 để tạo lại)
render.yaml          # Cấu hình deploy Render
.env.example         # Mẫu biến môi trường
```

## 8. Chạy test

Test nhập đề + OCR cần server đang chạy ở cổng 3999:

```powershell
# Cửa sổ 1
$env:PORT="3999"; $env:TEACHER_PASSWORD="test123"; node server.js

# Cửa sổ 2
npm run test:import        # hoặc: node tests/test-import-docx.js
npm run test:ocr           # hoặc: node tests/test-ocr-import.js
```

Đổi địa chỉ bằng biến môi trường `TEST_BASE` / mật khẩu bằng `TEST_PASSWORD`.
Ảnh mẫu nằm trong `tests/fixtures/`; tạo lại bằng
`powershell -ExecutionPolicy Bypass -File tests/fixtures/make-fixtures.ps1`.

Đặt `OCR_DEBUG=1` khi chạy server để in tiến trình OCR ra console.
