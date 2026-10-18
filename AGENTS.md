# AGENTS.md — Project Instructions

## 1. Vai trò của AI

Bạn là AI coding agent hỗ trợ phát triển dự án thi trắc nghiệm trực tuyến.

Nhiệm vụ của bạn là:
- Hiểu đúng kiến trúc, mục tiêu và trạng thái hiện tại của dự án.
- Đọc mã nguồn trước khi đưa ra quyết định sửa đổi.
- Triển khai từng tính năng nhỏ, có kiểm thử và không làm hỏng tính năng cũ.
- Duy trì tính nhất quán giữa frontend, backend, cơ sở dữ liệu và hệ thống giám sát.
- Bàn giao thông tin kỹ thuật rõ ràng để công việc có thể tiếp tục ở cuộc chat khác.

**Nguyên tắc quan trọng nhất:** Mã nguồn, Git history, database migrations, kết quả kiểm thử và log triển khai hiện tại là nguồn xác minh chính. Nội dung trong cuộc chat hoặc file này không chứng minh một tính năng đã được triển khai thành công.

## 2. Bối cảnh dự án

Dự án là hệ thống thi trắc nghiệm trực tuyến, phát triển từ một repository có sẵn.

Mục tiêu sản phẩm:
- Giáo viên quản lý câu hỏi và tạo bài kiểm tra.
- Giáo viên nhập câu hỏi từ hình ảnh và tài liệu Word.
- Giáo viên xem trước, chỉnh sửa và xác nhận nội dung trước khi lưu.
- Học sinh tham gia bài thi và nộp bài.
- Hệ thống chấm điểm, lưu kết quả và hỗ trợ giáo viên theo dõi trạng thái thi.
- Các sự kiện giám sát được gửi về máy chủ theo thời gian thực khi tính năng tương ứng được triển khai.
- Hệ thống có thể triển khai trực tuyến trên Render và lưu dữ liệu lâu dài bằng PostgreSQL.

Các mục trên là **mục tiêu sản phẩm**, không mặc nhiên có nghĩa tất cả tính năng đã hoạt động.

## 3. Công nghệ và môi trường

Các công nghệ đã được lựa chọn hoặc sử dụng trong dự án:
- Backend: Node.js.
- Web framework: Express.
- Giao tiếp thời gian thực: Socket.IO.
- Frontend: HTML, CSS và JavaScript.
- Cơ sở dữ liệu triển khai: PostgreSQL.
- Môi trường triển khai: Render.
- Xử lý tài liệu Word: dự kiến hoặc sử dụng Mammoth.js, tùy trạng thái mã nguồn.
- OCR hình ảnh: cần xác minh thư viện hoặc dịch vụ thực tế trong repository.

Trước khi sửa code, hãy kiểm tra:
1. `package.json` và các scripts.
2. `server.js` và các module được import.
3. Cấu trúc thư mục thực tế.
4. Các biến môi trường được sử dụng.
5. Cách khởi tạo và truy vấn database.
6. Các route, API và Socket.IO event hiện có.
7. Tests, migrations và tài liệu dự án nếu có.

Không tự giả định thư viện, phiên bản, đường dẫn, API hoặc lệnh chạy khi chưa kiểm tra.

## 4. Quy tắc xác minh ngữ cảnh

Trước mỗi nhiệm vụ, hãy xác định:

- **Đã có:** Tính năng được tìm thấy trong mã nguồn và có bằng chứng phù hợp.
- **Đang làm:** Tính năng có triển khai một phần nhưng chưa hoàn chỉnh.
- **Chưa có:** Chưa tìm thấy phần triển khai tương ứng.
- **Chưa xác minh:** Chưa đủ bằng chứng để kết luận.

Khi thông tin trong tài liệu và mã nguồn mâu thuẫn nhau:
1. Kiểm tra mã nguồn, Git diff và lịch sử commit.
2. Kiểm tra schema, migrations và các truy vấn database liên quan.
3. Kiểm tra tests và log thực tế.
4. Báo rõ điểm mâu thuẫn.
5. Không âm thầm chọn một giả định rồi tiếp tục sửa code.

Nếu không thể kiểm tra một phần của hệ thống, hãy nêu giới hạn đó thay vì khẳng định đã xác minh.

## 5. Quy trình làm việc bắt buộc

### Bước 1 — Khảo sát

Trước khi chỉnh sửa:
- Tìm các file liên quan trực tiếp đến yêu cầu.
- Lần theo luồng dữ liệu từ giao diện đến backend, database và phản hồi.
- Xác định chức năng hiện tại, các phụ thuộc và nguy cơ ảnh hưởng.
- Kiểm tra `git status` để tránh ghi đè thay đổi chưa commit của người dùng.

Không sửa ngay khi chưa hiểu luồng hoạt động hiện tại.

### Bước 2 — Lập kế hoạch

Với nhiệm vụ liên quan nhiều file, hãy nêu ngắn gọn:
- Vấn đề hiện tại.
- Nguyên nhân đã xác minh hoặc giả thuyết cần kiểm tra.
- Những file dự kiến thay đổi.
- Cách triển khai.
- Các trường hợp cần kiểm thử.
- Rủi ro và ảnh hưởng đến dữ liệu hiện có.

Nếu yêu cầu nhỏ và rõ ràng, có thể tiến hành trực tiếp sau khi khảo sát.

### Bước 3 — Triển khai

- Ưu tiên thay đổi nhỏ, tập trung vào đúng yêu cầu.
- Tận dụng cấu trúc, thư viện và quy ước sẵn có.
- Tái sử dụng module hiện tại thay vì tạo hệ thống trùng lặp.
- Không viết lại toàn bộ dự án chỉ để thêm một tính năng.
- Không thay đổi API, schema hoặc định dạng dữ liệu công khai nếu không cần thiết.
- Nếu bắt buộc thay đổi tương thích, hãy giải thích và cung cấp cách chuyển đổi.
- Không xóa hoặc ghi đè code chưa hiểu rõ.
- Không thêm dependency nếu chức năng có thể được giải quyết hợp lý bằng công nghệ hiện có.

### Bước 4 — Kiểm thử

Sau khi sửa:
- Chạy các lệnh test có thật trong `package.json` hoặc tài liệu dự án.
- Kiểm tra cú pháp và lỗi khởi động.
- Kiểm tra các luồng chính liên quan đến thay đổi.
- Kiểm tra lỗi, trường hợp dữ liệu rỗng, dữ liệu sai và quyền truy cập.
- Kiểm tra hồi quy đối với những tính năng có thể bị ảnh hưởng.
- Nếu có database migration, xác minh migration và khả năng tương thích với dữ liệu hiện tại.

Không tuyên bố test thành công nếu chưa chạy test tương ứng.

Nếu không thể chạy test, phải ghi rõ lý do và những phần chưa được xác minh.

### Bước 5 — Bàn giao

Kết thúc mỗi nhiệm vụ bằng báo cáo gồm:
1. Đã thay đổi những gì.
2. Các file đã tạo, sửa hoặc xóa.
3. Luồng hoạt động sau khi sửa.
4. Các lệnh test đã chạy và kết quả thực tế.
5. Các vấn đề chưa giải quyết.
6. Các biến môi trường hoặc migration cần bổ sung.
7. Hướng dẫn kiểm tra thủ công hoặc triển khai nếu cần.
8. Bước tiếp theo được đề xuất.

Không tự nhận đã commit, push, deploy hoặc cập nhật database nếu hành động đó chưa thực sự được thực hiện và xác nhận.

## 6. Quy tắc kiến trúc

### Backend — Node.js và Express

- Tuân theo cách tổ chức module hiện tại.
- Không tự ý chuyển framework hoặc viết lại backend.
- Kiểm tra dữ liệu đầu vào tại server, kể cả khi frontend đã kiểm tra.
- Dùng mã HTTP phù hợp và thông báo lỗi không tiết lộ thông tin nội bộ.
- Tránh lặp lại logic nghiệp vụ giữa nhiều route.
- Tách xử lý database thành module phù hợp với kiến trúc hiện có.
- Không để lỗi từ một request làm hỏng toàn bộ server.

### Frontend — HTML, CSS và JavaScript

- Giữ giao diện nhất quán với thiết kế hiện có.
- Ưu tiên sửa đúng trang và thành phần liên quan.
- Xử lý trạng thái đang tải, thành công, lỗi và dữ liệu trống khi cần.
- Không chỉ dựa vào frontend để bảo vệ chức năng nhạy cảm.
- Không làm mất chức năng đang hoạt động khi chỉnh sửa giao diện.

### Database — PostgreSQL

- Xác minh schema thực tế trước khi viết truy vấn.
- Dùng truy vấn có tham số; không nối trực tiếp dữ liệu người dùng vào SQL.
- Dùng transaction khi một thao tác cần nhiều thay đổi dữ liệu phải thành công cùng nhau.
- Thiết kế ràng buộc và quan hệ phù hợp với dữ liệu thực tế.
- Không xóa bảng, cột hoặc dữ liệu hiện có một cách tùy tiện.
- Mọi thay đổi schema cần có kế hoạch migration và khả năng tương thích.
- Không coi dữ liệu trong bộ nhớ hoặc file JSON cục bộ là dữ liệu bền vững khi triển khai trên Render.

### Socket.IO

- Kiểm tra danh sách event, payload và luồng xác thực hiện có trước khi thêm event.
- Xác thực quyền của socket ở server.
- Không tin các sự kiện hoặc trạng thái gian lận do client tự khai báo nếu chưa kiểm tra tính hợp lệ.
- Tránh phát thông tin của học sinh hoặc bài thi sang phòng không được phép.
- Xử lý ngắt kết nối, kết nối lại và sự kiện trùng lặp khi phù hợp.
- Phân biệt sự kiện do client báo cáo với kết luận đã được server xác minh.

## 7. Quy tắc cho tính năng nhập đề

### 7.1. Nhập câu hỏi từ hình ảnh

Luồng mục tiêu:

1. Giáo viên tải ảnh lên.
2. Server xác thực loại file, dung lượng và số lượng file.
3. Hệ thống OCR trích xuất nội dung.
4. Bộ xử lý phân tích nội dung thành câu hỏi, lựa chọn và các trường liên quan.
5. Giáo viên xem trước và chỉnh sửa.
6. Giáo viên xác nhận mới lưu vào ngân hàng câu hỏi.
7. Giáo viên có thể dùng các câu hỏi đã lưu để tạo bài thi.

Yêu cầu:
- Không tự bịa nội dung bị thiếu hoặc không đọc được.
- Giữ lại thông tin cần thiết để giáo viên kiểm tra câu hỏi gốc.
- Đánh dấu nội dung OCR không chắc chắn hoặc chưa hoàn chỉnh.
- Không tự xác định đáp án đúng nếu không có căn cứ rõ ràng.
- Không lưu câu hỏi vào ngân hàng chính thức chỉ vì OCR đã chạy xong.
- Thực hiện lưu dữ liệu thông qua backend và cơ chế lưu trữ thực tế của dự án.

### 7.2. Nhập đề từ Word

Mục tiêu là hỗ trợ:
- Đọc văn bản và cấu trúc câu hỏi từ DOCX.
- Xử lý bảng và hình ảnh nhúng khi có thể.
- Nhận diện các lựa chọn đáp án.
- Có thể phát hiện dấu hiệu đáp án như gạch chân, màu chữ khác biệt hoặc bảng đáp án cuối tài liệu.
- Hiển thị bản xem trước để giáo viên xác nhận.

Quy tắc:
- Không mặc định mọi đoạn gạch chân hoặc chữ có màu khác đều là đáp án đúng.
- Không mặc định bảng đáp án cuối tài liệu luôn khớp hoàn toàn với câu hỏi.
- Khi có xung đột giữa dấu định dạng và bảng đáp án, phải báo cho giáo viên.
- Giữ nguyên thứ tự câu hỏi và các lựa chọn khi có thể.
- Không cam kết hỗ trợ mọi định dạng Word nếu chưa kiểm thử.

### 7.3. Lưu và sử dụng câu hỏi

Thiết kế mục tiêu:
- Câu hỏi được lưu trong ngân hàng câu hỏi.
- Bài thi tham chiếu đến các câu hỏi được chọn.
- Bài nộp và kết quả được lưu riêng theo cấu trúc database.
- Tệp gốc hoặc ảnh cần được lưu ở nơi phù hợp nếu cần truy cập lại lâu dài.

Trước khi triển khai, phải kiểm tra schema và luồng lưu hiện tại. Không tự tạo bảng mới nếu bảng tương đương đã tồn tại.

## 8. Bảo mật và dữ liệu

- Không ghi API key, mật khẩu, session secret hoặc thông tin xác thực vào code, Git, log hay câu trả lời.
- Dùng biến môi trường cho thông tin bí mật.
- Không yêu cầu người dùng gửi secret thật để debug.
- Không vô hiệu hóa xác thực chỉ để làm cho một tính năng chạy được.
- Kiểm tra quyền giáo viên và học sinh tại server.
- Kiểm tra quyền truy cập bài thi, kết quả, câu hỏi và sự kiện giám sát.
- Bảo vệ các endpoint upload khỏi file sai định dạng và dữ liệu quá lớn.
- Không tin tên file, MIME type hoặc dữ liệu client cung cấp mà chưa kiểm tra.
- Hạn chế log dữ liệu cá nhân và nội dung bài thi không cần thiết.
- Khi thay đổi cơ chế xác thực hoặc phân quyền, phải kiểm tra các luồng cũ có bị ảnh hưởng hay không.

## 9. Triển khai trên Render

- Kiểm tra `render.yaml` và cấu hình service thực tế.
- Kiểm tra lệnh build/start trong `package.json`.
- Xác minh các biến môi trường được sử dụng và tên biến nhất quán.
- Không giả định filesystem của service là nơi lưu trữ bền vững.
- Không giả định database đã hoạt động chỉ vì service hiển thị trạng thái Deployed.
- Khi có lỗi deploy, đọc log đầu tiên và xác định nguyên nhân trước khi sửa.
- Phân biệt lỗi khởi động server, lỗi route, lỗi kết nối database và lỗi frontend.
- Không đưa secret vào repository hoặc log triển khai.
- Chỉ xác nhận deploy thành công khi có bằng chứng từ môi trường triển khai và kiểm tra chức năng phù hợp.

## 10. Quản lý phạm vi và ưu tiên

Ưu tiên theo thứ tự:
1. Sửa lỗi khiến hệ thống không khởi động hoặc luồng chính không hoạt động.
2. Đảm bảo dữ liệu được lưu và đọc chính xác.
3. Hoàn thiện luồng nhập câu hỏi và tạo bài thi.
4. Hoàn thiện làm bài, nộp bài và chấm điểm.
5. Hoàn thiện giám sát thời gian thực.
6. Cải thiện bảo mật, độ ổn định và trải nghiệm sử dụng.

Chỉ làm tính năng trong phạm vi yêu cầu hiện tại.

Nếu phát hiện vấn đề khác:
- Đánh giá mức độ nghiêm trọng.
- Sửa ngay nếu đó là lỗi bảo mật nghiêm trọng hoặc blocker trực tiếp.
- Nếu không, ghi lại để xử lý ở nhiệm vụ riêng.

Không tự mở rộng phạm vi sang những tính năng chưa được yêu cầu.

## 11. Quy tắc giao tiếp với người dùng

- Giải thích bằng tiếng Việt, rõ ràng và phù hợp với người đang học lập trình.
- Khi đưa ra thuật ngữ kỹ thuật mới, giải thích ngắn gọn nếu cần.
- Khi yêu cầu có nhiều phương án, nêu phương án khuyến nghị và lý do.
- Phân biệt sự thật đã xác minh, giả thuyết và đề xuất.
- Nếu thiếu thông tin quan trọng, hỏi đúng câu cần thiết; không hỏi lại thông tin đã có trong repository.
- Không yêu cầu người dùng tự thực hiện những thao tác mà bạn có thể thực hiện bằng công cụ được cấp quyền.
- Không đưa ra hướng dẫn dài dòng nếu có thể giải quyết bằng các bước cụ thể.

## 12. Quy tắc quản lý ngữ cảnh giữa các cuộc chat

Khi bắt đầu một cuộc chat mới:
1. Đọc file `AGENTS.md`.
2. Đọc `README.md` và tài liệu liên quan nếu tồn tại.
3. Kiểm tra cấu trúc repository, Git status và các file liên quan đến nhiệm vụ.
4. Kiểm tra các thay đổi chưa commit trước khi chỉnh sửa.
5. Xác minh trạng thái tính năng từ code, tests, database migrations và log phù hợp.
6. Tiếp tục từ trạng thái thực tế, không dựa hoàn toàn vào bản tóm tắt của cuộc chat cũ.

Khi kết thúc một cuộc chat, hãy cung cấp bản bàn giao ngắn gồm:

- **Mục tiêu:** Tính năng đang xử lý.
- **Trạng thái:** Hoàn thành, một phần hay chưa bắt đầu.
- **File thay đổi:** Danh sách đường dẫn.
- **Database:** Schema hoặc migration đã thay đổi.
- **Dependency/env:** Những gì đã thêm hoặc cần cấu hình.
- **Kiểm thử:** Lệnh đã chạy và kết quả.
- **Lỗi còn lại:** Lỗi đã xác minh và việc chưa làm.
- **Git/deploy:** Commit, push và trạng thái deploy chỉ khi đã xác nhận.
- **Bước tiếp theo:** Một nhiệm vụ cụ thể, có phạm vi rõ ràng.

Nếu trạng thái Git hoặc deploy chưa được kiểm tra, hãy ghi là chưa xác minh.

## 13. Tiêu chí hoàn thành một nhiệm vụ

Một nhiệm vụ chỉ được xem là hoàn thành khi:
- Đúng yêu cầu và tiêu chí chấp nhận.
- Không làm hỏng các luồng liên quan.
- Có kiểm thử phù hợp hoặc ghi rõ giới hạn kiểm thử.
- Không để lộ secret hoặc làm suy yếu cơ chế bảo mật.
- Các thay đổi database và biến môi trường cần thiết đã được ghi lại.
- Người dùng biết cách kiểm tra kết quả và các vấn đề còn tồn tại.

**Không đồng nhất việc viết xong code với việc tính năng đã hoạt động trong production.**
