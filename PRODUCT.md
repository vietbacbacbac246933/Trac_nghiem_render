# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Học sinh — người làm bài.** Ngồi trong lớp, dùng **điện thoại của chính mình**, làm bài **đồng thời** với cả lớp trong tiết kiểm tra. Việc các em cần làm: chọn đúng tên mình trong danh sách của lớp (không có mã PIN), làm bài đã được giáo viên mở, nộp bài, và biết kết quả. Mỗi tên chỉ một học sinh làm bài: tên bị khóa ngay khi được chọn.

**Giáo viên — người ra đề và tổ chức thi.** Việc cần làm: quản lý lớp và danh sách học sinh, nhập đề từ file Word/ảnh đã soạn sẵn, sửa và xác nhận đề trước khi lưu, mở/đóng bài thi cho cả lớp, theo dõi học sinh đang làm, xem điểm và xuất Excel.

Chưa có bằng chứng về vai thứ ba (phụ huynh, quản trị viên nhà trường, học sinh tự đăng ký tài khoản).

## Product Purpose

Biến đề kiểm tra mà giáo viên **đã có sẵn trên giấy hoặc trong file Word** thành một bài thi trực tuyến có giám sát, mà không phải gõ lại từng câu. Sản phẩm tồn tại để một giáo viên có thể tổ chức cho cả lớp làm bài trên điện thoại trong tiết học, rồi có điểm ngay, với chi phí hạ tầng gần như bằng không.

Thành công nghĩa là: giáo viên nhập được đề thật (kể cả đề in 2 cột, có công thức, có ảnh) mà không phải sửa tay quá nhiều; học sinh vào được bài trong vài giây không cần mã PIN; và giáo viên đọc được kết quả theo lớp ngay sau khi hết giờ.

## Positioning

Cơ chế riêng: **đọc đề từ Word/ảnh và tự nhận ra đáp án đúng** — dấu `*`, `[x]`, `(đúng)`, hoặc **gạch chân dưới đáp án** (dò trực tiếp điểm ảnh, và trong `.docx` theo định dạng gạch chân, chỉ xét trong dòng đáp án). Kết quả luôn đi qua **bản xem trước sửa được** và chỉ ghi dữ liệu khi giáo viên bấm xác nhận; câu thiếu căn cứ bị gắn nhãn *cần kiểm tra* và **bị bỏ qua khi lưu** chứ không tự gán đáp án A.

Sản phẩm giữ được **giám sát thi trực tiếp** (mở/đóng bài theo thời gian thực, phát hiện thoát toàn màn hình và chuyển tab, lịch sử chọn nhầm tên, cho phép thi lại) — thứ mà Google Forms không có — nhưng chạy trên **hạ tầng tự host, không thu phí theo đầu học sinh** như Quizizz/Azota. Lợi thế cạnh tranh không nằm ở giao diện thi, mà ở **chi phí nhập đề bằng 0 cho giáo viên**.

## Operating Context

- **Một phòng học, một lớp, một thời điểm.** Giáo viên mở bài từ máy của mình, cả lớp làm cùng lúc trên điện thoại cá nhân.
- **Hạ tầng: Internet, không phải LAN.** Server chạy trên Render kèm PostgreSQL; tên gọi cũ "LAN" là di sản của bản gốc chạy trong mạng nội bộ.
- **Một instance duy nhất.** Socket.IO giữ trạng thái trong RAM của process, nên mọi trạng thái thi (ai đang làm, mở/đóng bài) sống trong một process.
- **Đầu vào là đề có sẵn:** `.docx` do giáo viên soạn, hoặc ảnh chụp/scan đề giấy. Giáo viên nhập đề **trước** giờ kiểm tra, không phải trong lúc học sinh đang làm.
- **Thiết bị học sinh là điện thoại** (màn hình nhỏ, cảm ứng, bàn phím ảo) — không phải máy tính phòng máy.
- **Gói miễn phí của Render sẽ ngủ** sau khoảng 15 phút không dùng, nên lần truy cập đầu có thể chậm.

## Capabilities and Constraints

Đã có (có bằng chứng trong mã nguồn):

- Quản lý lớp; nhập danh sách học sinh từ file; kết quả xuất Excel.
- Quản lý ngân hàng câu hỏi và nhiều bài kiểm tra; chuyển đổi giữa các bài.
- Nhập đề từ `.docx` và từ ảnh rời; nhập đề từ ảnh bằng OCR (tesseract.js mặc định, OCR.space nếu có `OCR_SPACE_API_KEY`).
- Bản xem trước sửa được: sửa nội dung/đáp án, chọn đáp án đúng, đổi loại câu (một đáp án / nhiều đáp án / Đúng–Sai), thêm–bớt đáp án, điểm từng câu, bật/tắt từng câu, lọc nhanh *Tất cả / Đọc hoàn hảo / Cần kiểm tra*.
- Mở/đóng bài thi, chế độ ôn tập (`practiceMode`), mật khẩu phòng thi.
- Học sinh chọn tên (không PIN), làm bài, nộp bài; lưu tiến trình; báo chọn nhầm tên; giáo viên duyệt/từ chối báo cáo và cho thi lại.
- Giám sát trực tiếp qua Socket.IO: `studentTabLeave`, `studentFullscreenExit`, `newResult`, `studentStatusUpdated`.
- Công thức toán (KaTeX) và ảnh nhúng trong câu hỏi được giữ.

Ràng buộc kỹ thuật (không được giả định là có thể thay đổi dễ dàng):

- **Chỉ chạy 1 instance** — nhiều instance cần Redis adapter, chưa có.
- Stack hiện tại: Node.js + Express + Socket.IO, giao diện HTML/CSS/JS thuần, lưu trữ PostgreSQL khi có `DATABASE_URL` và file JSON khi không có. Mã nguồn đã trả lời câu hỏi stack, không phải quyết định mở.
- Xác thực giáo viên hiện là **một mật khẩu duy nhất** (`TEACHER_PASSWORD`) + cookie ký HMAC.
- Tài liệu Word: không cam kết hỗ trợ mọi định dạng `.docx`.
- Giới hạn file nhập đề: `.docx` ≤ 15 MB, mỗi ảnh ≤ 8 MB, tổng ≤ 25 MB, tối đa 30 ảnh/lần; phiên xem trước tự xoá sau 30 phút.
- Dò gạch chân chỉ chạy với tesseract; nếu dùng OCR.space thì không dò được.
- Chưa giới hạn tần suất ở mọi API (chỉ có ở đăng nhập giáo viên).

Yêu cầu đã xác nhận nhưng **chưa có trong mã nguồn** (không được mô tả như tính năng đang hoạt động):

- **Tách tài khoản riêng cho từng giáo viên.** Người dùng xác nhận cần mỗi giáo viên một tài khoản/mật khẩu riêng và chỉ thấy dữ liệu, lớp của mình, trên cùng một server dùng chung. Hiện tại code chỉ có một `TEACHER_PASSWORD` dùng chung cho toàn bộ server.

Chưa quyết:

- Ai tạo tài khoản giáo viên và bằng cách nào (tự đăng ký / quản trị viên cấp / mời).
- Số lớp và số học sinh đồng thời tối đa cần chịu được.
- Có giữ chế độ lưu bằng file JSON song song với PostgreSQL hay không.

## Brand Commitments

**Không có ràng buộc thương hiệu nào đang ràng buộc.** Người dùng xác nhận tên "Trắc Nghiệm LAN" và `public/logo.svg` (biểu tượng mạng LAN + dấu check) **sẽ được thay** — hãy coi chúng là tạm thời, không phải bản sắc phải bảo toàn.

Chưa có: tên mới, logo mới, giọng điệu, hay bảng màu được người dùng chốt.

## Evidence on Hand

Nội dung thật, có thể dùng làm bằng chứng (đường dẫn trong repo):

- `data/de-mau-test.docx`, `data/de-mau-toan.docx`, `data/de-tin-demo.docx`, `data/de-toan-demo3.docx`, `data/de-toan-mau.docx`, `data/de-toan-thpt-mau2.docx`, `data/mau-cau-hoi.docx` — đề thật của giáo viên.
- `data/questions.json`, `data/mau-cau-hoi.json` — dữ liệu câu hỏi gieo ban đầu.
- `data/exams/*.json` — 8 bài kiểm tra đã tạo.
- `tests/fixtures/` — ảnh mẫu cho test OCR (kèm `make-fixtures.ps1` để tạo lại).
- `TRIEN-KHAI-RENDER.md` — nhật ký kiểm thử thật (60/60, 61/61, 84/84… theo từng đợt).
- `README.md` — mô tả luồng và các quy tắc nhập đề.

**Không được bịa:** không có testimonial, khách hàng tham chiếu, số liệu benchmark, bảng giá, thông cáo báo chí, hay danh sách trường học. Dữ liệu học sinh thật **không** được commit (đã chặn trong `.gitignore`) nên không có tên học sinh thật để dùng làm ví dụ.

## Product Principles

1. **Không tự bịa dữ liệu.** Khi thiếu căn cứ, sản phẩm báo "cần kiểm tra" và bỏ qua, chứ không đoán. Điều này áp dụng cho cả câu hỏi do máy nhập lẫn nội dung sản phẩm tự viết.
2. **Giáo viên là người quyết định cuối cùng.** Không có gì được ghi vào dữ liệu chính thức trước khi giáo viên xem và xác nhận.
3. **Điện thoại của học sinh là thiết bị chính**, không phải màn hình máy tính — thiết kế cho màn hình nhỏ và thao tác cảm ứng trước.
4. **Đề có sẵn là đầu vào, không phải việc phải làm lại.** Bất kỳ tính năng nào bắt giáo viên gõ lại nội dung họ đã có là đi ngược lại lý do sản phẩm tồn tại.
5. **Tự host, miễn phí, một server cho nhiều giáo viên.** Không phụ thuộc dịch vụ thu phí theo đầu người; hướng tới nhiều giáo viên cùng dùng một server với dữ liệu tách theo từng người.
