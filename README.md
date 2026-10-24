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
| Danh sách học sinh | Có thể truy cập tự do | Mỗi tên chỉ cho 1 học sinh chọn (không dùng mã PIN) |
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

Xem `.env.example`.

**Nhập đề từ ảnh/OCR đã được gỡ** để giảm RAM trên Render. Hiện chỉ hỗ trợ
nhập đề từ file Word `.docx` (kể cả ảnh nhúng trong file Word).


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
- Vào `/teacher`, đăng nhập, chọn lớp + bài kiểm tra. **Học sinh không cần mã
  PIN**: mỗi em tự chọn tên của mình, hệ thống khóa tên ngay nên 2 người không
  thể cùng chọn 1 tên.
- **Chỉ chạy 1 instance** (Socket.IO dùng RAM của process).

## 5. Luồng sử dụng

1. Giáo viên đăng nhập `/teacher`.
2. Chọn lớp + bài kiểm tra, mở bài thi.
3. Học sinh mở `/`, chọn tên mình rồi bấm **Xác nhận** (không cần mã PIN).
   Tên đã có người chọn sẽ bị khóa, người khác không chọn được nữa.
4. Học sinh làm bài và nộp. Giáo viên xem điểm, xuất Excel.

### Nhập đề thi từ Word (.docx)

Trong **Quản lý Bài kiểm tra** → nút **“Nhập Word”**:

1. Chọn 1 file `.docx`.
2. Server kiểm tra phần mở rộng, MIME type, **magic bytes** và dung lượng.
3. Server trích văn bản (kèm công thức toán và ảnh nhúng) rồi phân tích thành
   câu hỏi / đáp án.
4. Hiện **bản xem trước cho sửa được**: nội dung câu, đáp án, chọn đáp án đúng,
   đổi loại câu (một đáp án / nhiều đáp án / Đúng–Sai), thêm–bớt đáp án, **điểm**
   từng câu, bật/tắt từng câu. Có **bộ lọc nhanh** *Tất cả / ✓ Đọc
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
- **Ảnh nhúng trong `.docx`** được giữ và gắn vào đúng câu hỏi.
- **Không lưu file tạm vô thời hạn:** file được xử lý trong RAM; ảnh chỉ được
  giữ trong “phiên xem trước” 30 phút rồi tự xoá. Không ghi file tạm ra đĩa và
  **không bao giờ thực thi file tải lên**.
- Giới hạn: `.docx` ≤ 15 MB.

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
- **Tiêu đề phần ghi “học sinh chọn đúng hoặc sai”** (đề 2025: `PHẦN II. (4,0 điểm) …
  chọn đúng hoặc sai.`) cũng được nhận là phần **Đúng/Sai**, nên bảng
  `ĐÁP ÁN TRẮC NGHIỆM ĐÚNG SAI` ở cuối file ghép được đáp án từng ý a) b) c) d).
- **Phần không câu nào có phương án A/B/C/D** (ví dụ `PHẦN III. (1,5 điểm) Học sinh
  trả lời từ câu 1 đến câu 6.` — tiêu đề không ghi loại) được nhận là **trả lời
  ngắn**, ghép đáp án từ bảng `ĐÁP ÁN TRẮC NGHIỆM TRẢ LỜI NGẮN`. Nếu chỉ *một vài*
  câu mất phương án thì giữ nguyên trắc nghiệm và đánh dấu *cần kiểm tra*.
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

### Xuất bài kiểm tra offline (1 file HTML)

Xuất được ở **hai chỗ**, cùng một cấu hình:

- **Tab Câu hỏi → 📄 Nhập đề từ Word / Xuất file offline:** xuất thẳng ngân hàng câu
  hỏi đang mở (đúng câu hỏi và điểm đang có) — không phải nhập lại file Word.
- **Bản xem trước sau khi nhập Word:** xuất ngay bản đang xem, chưa cần lưu.

File `.html` tạo ra tự chạy, không cần server hay mạng:

- **Ôn tập:** làm lại theo **số lượt** giáo viên đặt (`0` = không giới hạn); sau khi
  nộp xem được điểm, đáp án đúng và bài làm.
- **Thi:** **1 lượt**, có thể đặt **thời gian** (phút); hết giờ tự nộp. Giáo viên
  chọn có hiện đáp án sau khi nộp hay không.
- **Lịch sử làm bài:** mỗi lượt là một dòng thu gọn (điểm + thời điểm); bấm vào
  đúng lượt cần xem mới hiện chi tiết bài làm của lượt đó: **bảng đáp án** tô màu
  (xanh = đúng, vàng = đúng một phần, đỏ = sai, xám = chưa trả lời) và danh sách câu
  kèm đáp án đúng / đáp án đã chọn. Bấm một ô trong bảng để nhảy ngay tới câu đó.
  Có bộ lọc **Tất cả / Đúng / Đúng một phần / Sai / Chưa trả lời**. 30 lượt gần nhất
  còn xem lại được chi tiết; lượt cũ hơn chỉ còn điểm.
- **Báo đúng/sai ngay:** bật khi xuất để học sinh chọn xong mỗi câu là biết ngay
  đúng/sai (kèm đáp án đúng nếu giáo viên cho xem đáp án). Mặc định tắt.
- **Nộp bài xong tự về đầu trang** để thấy ngay điểm và bảng đáp án.
- **Hộp thoại xác nhận nộp bài nằm trong trang** (không dùng `confirm` của trình
  duyệt), nên bấm "Nộp bài" hoạt động cả trên Safari iOS và khi file được mở trong
  app/khung xem khác (Zalo, Drive…) — nơi hộp thoại của trình duyệt bị chặn.
- **Nút ▲ / ▼** ở góc phải gần cuối màn hình để lên đầu hoặc xuống cuối trang khi xem lại.
- **Chống gian lận** (mặc định bật, tắt được khi xuất): tự bật toàn màn hình khi
  bấm vào file, không chọn/copy được nội dung, chặn chuột phải và các phím tắt
  (Ctrl+C/X/A/S/P/U/F, Ctrl+Shift+I/J/C, F12). Đây chỉ là rào cản, không chống được
  học sinh đọc mã nguồn hay dùng máy khác.
- **Trộn câu hỏi và lựa chọn:** mỗi lượt làm xáo lại thứ tự câu **và** thứ tự các
  lựa chọn A/B/C/D trong từng câu (mặc định bật, tắt được khi xuất). Chữ cái hiển thị
  theo vị trí đã trộn, nhưng điểm và đáp án vẫn tính theo câu gốc; xem lại bài làm
  hiện đúng thứ tự lựa chọn của chính lượt đó. Câu Đúng–Sai giữ nguyên ý a) b) c) d).
- Hỗ trợ đủ 4 loại câu (một đáp án / nhiều đáp án / Đúng–Sai / trả lời ngắn), điểm
  từng câu, ảnh nhúng và công thức toán (render sẵn MathML). Câu Đúng–Sai có nút
  **Đúng/Sai** to, rõ cho từng ý a)–d); câu trả lời ngắn có ô nhập số kèm gợi ý định
  dạng. Khi xem lại, mỗi ý Đúng–Sai hiện đáp án và lựa chọn của học sinh (✔/✘).
- Tiến trình và số lượt lưu bằng `localStorage` của trình duyệt; tải lại trang vẫn
  tiếp tục bài đang làm.
- Câu chưa hợp lệ bị chặn trước khi xuất (không tự bỏ câu, không tự gán đáp án).

**Giới hạn:** đáp án nằm trong file nên chỉ phù hợp để giao học sinh tự ôn/tự làm;
không chống được học sinh đọc mã nguồn. Xoá dữ liệu trình duyệt sẽ xoá lượt đã làm.

### Nhập đề từ ẢNH bằng OCR (đã gỡ)

Chức năng này đã được gỡ cùng `tesseract.js`, `pngjs`, `jpeg-js` và các route
`/api/ocr/*` để giảm RAM trên Render. Nếu cần nhập đề có hình, hãy chèn ảnh
trong file Word; ảnh nhúng trong `.docx` vẫn được giữ.

**Điểm từng câu:** ô `Điểm` là **điểm thực của câu** (mặc định 1). Điểm bài là
tổng điểm các câu, nên có thể **lớn hơn 10**. Câu Đúng/Sai 4 ý được chấm theo
số ý đúng: 1 ý = 0,1; 2 ý = 0,25; 3 ý = 0,5; 4 ý = 1 điểm (nhân với điểm tối đa
của câu). Trong tab **Câu hỏi** có bộ lọc theo phần (một đáp án / Đúng–Sai / trả
lời ngắn / nhiều đáp án) và nút áp dụng nhanh cùng một mức điểm cho mọi câu của
phần đang chọn.

API mới (đều yêu cầu đăng nhập giáo viên):

| API | Việc |
|---|---|
| `POST /api/import/preview` | Nhận 1 file `.docx`, kiểm tra, phân tích, trả bản xem trước + `sessionId` |
| `POST /api/import/confirm` | Lưu câu hỏi sau khi giáo viên xác nhận |
| `POST /api/export/offline` | Xuất câu hỏi thành 1 file HTML offline (có `sessionId` = từ bản xem trước, không có = từ ngân hàng đang mở) |
| `GET /api/exams/:examId` | Đọc nội dung 1 bài đã lưu (chỉ đọc) |

## 6. Giới hạn đã biết

- **Socket.IO lưu trong RAM** → bắt buộc 1 instance. Muốn nhiều instance phải
  gắn Redis adapter (chưa làm).
- **Gói Free của Render** sẽ ngủ sau ~15 phút không dùng (lần đầu vào chậm) và
  Postgres free có thời hạn.
- **Không còn mã PIN**: học sinh tự chọn tên trong danh sách, server khóa tên
  ngay khi học sinh bấm Xác nhận nên **mỗi tên chỉ 1 học sinh** làm bài. Học
  sinh bấm nhầm tên vẫn hủy được ở hộp xác nhận trước khi bị khóa.
- `socketId` do trình duyệt gửi lên nên về lý thuyết có thể giả mạo (rủi ro
  thấp, cần biết ID của phiên khác).
- Chưa giới hạn tần suất ở mọi API (chỉ có ở đăng nhập giáo viên).

## 7. Cấu trúc thư mục

```
server.js            # Toàn bộ server (giữ nguyên nghiệp vụ bản LAN)
lib/datastore.js     # Lớp lưu trữ PostgreSQL / file
lib/auth.js          # Xác thực giáo viên (cookie ký HMAC)
lib/file-validate.js # Kiểm tra định dạng/dung lượng file nhập đề
lib/import-sessions.js # Phiên xem trước khi nhập đề (RAM, tự hết hạn)
lib/mem-monitor.js   # Bộ đo RAM nền (process.memoryUsage mỗi 30s)
scripts/mem-stats.js # Tính thống kê RAM nền từ log [MEM]
public/              # Giao diện học sinh, giáo viên, trang đăng nhập
data/                # Dữ liệu gieo ban đầu (câu hỏi, đề thi, file mẫu)
tests/               # Test (chạy tay, cần server đang chạy)
render.yaml          # Cấu hình deploy Render
.env.example         # Mẫu biến môi trường
```

## 8. Chạy test

Test nhập đề cần server đang chạy ở cổng 3999:

```powershell
# Cửa sổ 1
$env:PORT="3999"; $env:TEACHER_PASSWORD="test123"; node server.js

# Cửa sổ 2
npm run test:import        # hoặc: node tests/test-import-docx.js
npm run test:mem           # test bộ đo RAM, không cần server
```

Đổi địa chỉ bằng biến môi trường `TEST_BASE` / mật khẩu bằng `TEST_PASSWORD`.

## 9. Đo RAM nền và đánh giá giới hạn 512 MB

Server tự ghi một dòng log mỗi **30 giây** (không cần bật gì thêm):

```
[MEM] t=2026-10-21T14:46:25.984Z uptime=30s pid=8212 rss=62.8MB heapUsed=26.0MB heapTotal=28.7MB external=5.1MB arrayBuffers=2.9MB
```

- `rss` = RAM tiến trình Node.js đang chiếm (gần nhất với giới hạn Render).
- `heapUsed/heapTotal` = heap JS; `external/arrayBuffers` = buffer, ảnh base64…
- `uptime` = số giây kể từ khi tiến trình khởi động.
- Bộ đo chỉ chạy 1 timer duy nhất, `unref()` nên không giữ process sống và
  **không** nằm trong route/middleware (không tốn thêm gì cho mỗi request).

### Quy trình đo RAM nền trên Render
1. Deploy. Mở **Render → service → Logs**, tìm dòng `[MEM] Bat dau do RAM moi 30s`.
2. Để server **nhàn rỗi 5–10 phút** (không mở trang giáo viên, không cho học sinh vào).
3. Copy các dòng `[MEM]` vào một file, ví dụ `mem.log`.
4. Tính thống kê:
   ```powershell
   node scripts/mem-stats.js mem.log --skip 10   # bỏ 10 mẫu đầu lúc mới khởi động
   ```
   Script in ra số mẫu, khoảng thời gian, TB / trung vị / min / max của RSS và
   heapUsed, cùng ước tính `512 MB - RSS trung vị`.

### Đọc kết quả cho đúng
- Đây là **RAM của tiến trình Node.js** (`process.memoryUsage()`), **không phải
  RAM toàn bộ container**. Container còn có phần chạy Node runtime, thư viện
  native, bộ đệm hệ điều hành… nên RSS trung vị luôn **thấp hơn** mức Render báo.
- `512 MB - RSS nền` chỉ là **phép ước tính sơ bộ**. Không được coi toàn bộ phần
  còn lại là dùng được an toàn, và **không suy ra** 45–50 học sinh tốn bao nhiêu
  RAM chỉ từ con số nền.
- Một mẫu duy nhất không phải RAM nền: RSS thường giảm sau lần GC đầu tiên rồi mới
  ổn định. Cần nhiều mẫu sau khi server đã chạy ổn định.

### Đo khi tải tăng dần
1. Ghi lại RSS nền (bước trên).
2. Tăng tải theo bậc, mỗi bậc giữ 3–5 phút rồi đọc lại RSS/heapUsed:
   10 → 20 → 30 → 45 → 50 học sinh (dùng nhiều máy/trình duyệt hoặc k6).
3. Sau mỗi bậc, dừng tải 2–3 phút và xem RSS có **giảm về gần mức cũ** không.
   - Giảm về gần mức cũ → bộ nhớ được giải phóng, tạm ổn.
   - Tăng liên tục không giảm → nghi rò rỉ hoặc giữ tham chiếu quá lâu.
4. Theo dõi song song: HTTP 5xx, thời gian phản hồi (p95), timeout, và log Render
   `Ran out of memory`.
5. Nếu dùng k6: chỉ chạy **thử nghiệm nhỏ, tăng dần**, không chạy tải lớn trên
   production đang phục vụ học sinh thật.

### Kiến trúc và thành phần tốn RAM (đã kiểm tra mã nguồn)
- Một tiến trình duy nhất: `server.js` (Express + Socket.IO + `pg`).
- Timer định kỳ: bộ đo RAM (30s) và dọn phiên nhập đề (5 phút) — cả hai đều `unref()`.
- `DATA.cache` giữ toàn bộ dữ liệu JSON/PostgreSQL trong RAM và **không evict**.
- Kết quả chấm điểm lưu kèm nội dung câu/đáp án (có thể chứa ảnh base64).
- Ảnh nhúng trong Word nằm trong “phiên nhập đề” RAM, tối đa 20 phiên × 30 phút.

