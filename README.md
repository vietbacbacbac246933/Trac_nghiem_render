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
public/              # Giao diện học sinh, giáo viên, trang đăng nhập
data/                # Dữ liệu gieo ban đầu (câu hỏi, đề thi, file mẫu)
render.yaml          # Cấu hình deploy Render
.env.example         # Mẫu biến môi trường
```
