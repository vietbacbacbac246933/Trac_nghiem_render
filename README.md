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

Xem `.env.example`.

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
   đổi loại câu (một đáp án / nhiều đáp án / Đúng–Sai), thêm–bớt đáp án, bật/tắt
   từng câu.
5. Giáo viên bấm **Xác nhận lưu** thì mới ghi dữ liệu, vào **bài mới** hoặc
   **bài đang soạn** (tự chọn).

Nguyên tắc:

- **Không tự bịa dữ liệu.** Câu thiếu đáp án / thiếu nội dung / không xác định
  được ranh giới sẽ bị gắn nhãn *“cần kiểm tra”* kèm lý do, chứ không tự gán
  đáp án A. Khi bấm lưu, câu chưa hợp lệ sẽ bị **bỏ qua** và báo rõ lý do.
- **File ảnh rời**: mỗi ảnh tạo 1 câu có sẵn hình, **để trống** nội dung/đáp án
  và đánh dấu cần kiểm tra (không dùng OCR, giáo viên tự nhập chữ).
- **Ảnh nhúng trong `.docx`** được giữ và gắn vào đúng câu hỏi.
- **Không lưu file tạm vô thời hạn:** file được xử lý trong RAM; ảnh chỉ được
  giữ trong “phiên xem trước” 30 phút rồi tự xoá. Không ghi file tạm ra đĩa và
  **không bao giờ thực thi file tải lên**.
- Giới hạn: `.docx` ≤ 15 MB, mỗi ảnh ≤ 8 MB, tổng ≤ 25 MB, tối đa 30 ảnh/lần.

API mới (đều yêu cầu đăng nhập giáo viên):

| API | Việc |
|---|---|
| `POST /api/import/preview` | Nhận file, kiểm tra, phân tích, trả bản xem trước + `sessionId` |
| `POST /api/import/confirm` | Lưu câu hỏi sau khi giáo viên xác nhận |
| `GET /api/exams/:examId` | Đọc nội dung 1 bài đã lưu (chỉ đọc) |

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

## 7. Cấu trúc thư mục

```
server.js            # Toàn bộ server (giữ nguyên nghiệp vụ bản LAN)
lib/datastore.js     # Lớp lưu trữ PostgreSQL / file
lib/auth.js          # Xác thực giáo viên (cookie ký HMAC)
lib/file-validate.js # Kiểm tra định dạng/dung lượng file nhập đề
lib/import-sessions.js # Phiên xem trước khi nhập đề (RAM, tự hết hạn)
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
```

Đổi địa chỉ bằng biến môi trường `TEST_BASE` / mật khẩu bằng `TEST_PASSWORD`.
