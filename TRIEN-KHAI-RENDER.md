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

### File sửa
| File | Nội dung chính |
|---|---|
| `server.js` | PORT động; trust proxy; guard `/teacher.html`; route `/teacher`, `/teacher/login`, `/api/teacher/login|logout|session`; thay `isLocalhost`→`isTeacher` (49 chỗ); toàn bộ đọc/ghi dữ liệu chuyển qua `DATA.*`; ẩn `examPassword`; quản lý PIN + `/api/student-pins*`; `/api/select-student` đòi PIN; bootstrap bất đồng bộ + shutdown. |
| `package.json` | Thêm `jszip`, `xml-js`, `pg`; `engines.node >= 18`. |
| `public/teacher.html` | Nút Đăng xuất; tự chuyển trang khi 401; nút + hộp thoại “Mã PIN học sinh” (xem/tạo lại/tải Excel). |
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

> Chỉ chạy **1 instance** (Socket.IO giữ kết nối trong RAM của process).

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
```
Các file **được** commit làm dữ liệu gieo ban đầu: `data/questions.json`,
`data/exams/*.json`, `data/mau-cau-hoi.*`, `data/de-*.docx` (đều không tải được
qua HTTP).

---

## 7. Checklist sau khi deploy

- [ ] Mở `/api/ping` → trả JSON, HTTP 200.
- [ ] Mở `/` → hiện trang chọn tên.
- [ ] Mở `/teacher` → chuyển tới `/teacher/login`.
- [ ] Đăng nhập sai → báo lỗi; đăng nhập đúng → vào được.
- [ ] Thử tải `https://.../data/questions.json` → **404**.
- [ ] `/teacher` → “Mã PIN học sinh” → tạo PIN, tải Excel.
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
