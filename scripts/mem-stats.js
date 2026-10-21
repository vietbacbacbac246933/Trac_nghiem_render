'use strict';
/**
 * scripts/mem-stats.js
 * ---------------------------------------------------------------------------
 * Tinh thong ke RAM nen tu log cua lib/mem-monitor.js.
 *
 * Cach dung:
 *   1) Copy cac dong log [MEM] tu Render > Logs vao 1 file, vi du mem.log
 *   2) node scripts/mem-stats.js mem.log
 *      node scripts/mem-stats.js mem.log --skip 10   # bo 10 mau dau (luc moi khoi dong)
 *
 * Chi doc file log, KHONG ket noi Render, KHONG sua du lieu.
 */

var fs = require('fs');

// Parse cac dong dang:
//   [MEM] t=2026-10-21T10:00:00.000Z uptime=120s pid=1 rss=85.3MB heapUsed=42.1MB ...
function parse(text) {
    var out = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('[MEM]') < 0) continue;
        var s = { raw: line };
        var m;
        var re = /(\w+)=([\d.]+)MB/g;
        while ((m = re.exec(line)) !== null) {
            var key = m[1];
            if (key === 'rss' || key === 'heapUsed' || key === 'heapTotal' ||
                key === 'external' || key === 'arrayBuffers') {
                s[key] = parseFloat(m[2]);
            }
        }
        var up = line.match(/uptime=(\d+)s/);
        if (up) s.uptime = parseInt(up[1], 10);
        var t = line.match(/t=([0-9T:.\-Z]+)/);
        if (t) s.t = t[1];
        if (typeof s.rss === 'number') out.push(s);
    }
    return out;
}

function summarize(values) {
    var v = values.slice().sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var sum = v.reduce(function (a, b) { return a + b; }, 0);
    var mid = Math.floor(v.length / 2);
    var median = (v.length % 2) ? v[mid] : (v[mid - 1] + v[mid]) / 2;
    return {
        count: v.length,
        mean: sum / v.length,
        median: median,
        min: v[0],
        max: v[v.length - 1]
    };
}

function fmt(n) {
    return n === null || n === undefined ? '-' : n.toFixed(1) + ' MB';
}

function report(samples, skip) {
    var used = samples.slice(skip || 0);
    if (used.length < 2) {
        return 'Không đủ mẫu đo (cần ít nhất 2 mẫu sau khi bỏ qua ' + (skip || 0) + ' mẫu đầu).';
    }
    var rss = summarize(used.map(function (s) { return s.rss; }));
    var heap = summarize(used.map(function (s) { return s.heapUsed; }));
    var first = used[0];
    var last = used[used.length - 1];
    var spanS = (typeof first.uptime === 'number' && typeof last.uptime === 'number')
        ? (last.uptime - first.uptime) : null;

    var lines = [];
    lines.push('RAM nền (chỉ số của TIẾN TRÌNH Node.js, không phải cả container)');
    lines.push('Số mẫu dùng: ' + rss.count + (skip ? ' (đã bỏ ' + skip + ' mẫu đầu)' : ''));
    lines.push('Khoảng thời gian: từ ' + (first.t || '?') + ' đến ' + (last.t || '?') +
        (spanS != null ? ' (~' + Math.round(spanS / 60) + ' phút)' : ''));
    lines.push('');
    lines.push('RSS        : TB ' + fmt(rss.mean) + ' | trung vị ' + fmt(rss.median) +
        ' | min ' + fmt(rss.min) + ' | max ' + fmt(rss.max));
    lines.push('heapUsed   : TB ' + fmt(heap.mean) + ' | trung vị ' + fmt(heap.median) +
        ' | min ' + fmt(heap.min) + ' | max ' + fmt(heap.max));
    lines.push('');
    lines.push('Ước tính sơ bộ RAM nền theo RSS trung vị: ' + fmt(rss.median));
    lines.push('RAM còn lại theo phép trừ (512 MB - RSS trung vị): ' + fmt(512 - rss.median));
    lines.push('');
    lines.push('Lưu ý: đây chỉ là ước tính sơ bộ. Không suy ra RAM cho 45-50 học sinh');
    lines.push('chỉ từ con số này; phải đo thêm khi tải tăng dần (xem README).');
    return lines.join('\n');
}

function main(argv) {
    var file = null;
    var skip = 0;
    for (var i = 0; i < argv.length; i++) {
        if (argv[i] === '--skip') { skip = parseInt(argv[i + 1], 10) || 0; i++; }
        else if (!file) file = argv[i];
    }
    var text;
    if (file) {
        text = fs.readFileSync(file, 'utf8');
    } else {
        text = fs.readFileSync(0, 'utf8'); // stdin
    }
    var samples = parse(text);
    console.log(report(samples, skip));
}

module.exports = { parse: parse, summarize: summarize, report: report };

if (require.main === module) {
    main(process.argv.slice(2));
}
