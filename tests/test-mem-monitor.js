// Kiem thu bo do RAM nen + script tinh thong ke (khong can khoi dong server).
var assert = require('assert');
var memMonitor = require('../lib/mem-monitor');
var memStats = require('../scripts/mem-stats.js');

// 1) snapshot() tra ve du cac chi so dang so.
var s = memMonitor.snapshot();
assert.strictEqual(typeof s.t, 'number');
['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'].forEach(function (k) {
    assert.strictEqual(typeof s[k], 'number', 'thieu chi so ' + k);
    assert.ok(s[k] >= 0, k + ' phai >= 0');
});

// 2) format() co du nhan de doc/parse lai.
var line = memMonitor.format(s, s.t - 5000);
assert.ok(/^\[MEM\] t=/.test(line), line);
assert.ok(/uptime=5s/.test(line), line);
assert.ok(/rss=[\d.]+MB/.test(line), line);
assert.ok(/heapUsed=[\d.]+MB/.test(line), line);
assert.ok(/arrayBuffers=[\d.]+MB/.test(line), line);

// 3) Chi mot timer duy nhat khi goi start() nhieu lan.
assert.strictEqual(memMonitor.isRunning(), false);
var logs = [];
assert.strictEqual(memMonitor.start({ log: function (l) { logs.push(l); }, intervalMs: 100000 }), true);
assert.strictEqual(memMonitor.start({ log: function () {} }), false, 'start lan 2 phai bi bo qua');
assert.strictEqual(memMonitor.isRunning(), true);
assert.ok(logs.length >= 1, 'phai ghi mau t=0');
memMonitor.stop();
assert.strictEqual(memMonitor.isRunning(), false);
assert.strictEqual(memMonitor.stop(), false);

// 4) parse() doc lai dung cac dong log.
var sample = [
    '[MEM] t=2026-10-21T10:00:00.000Z uptime=30s pid=1 rss=80.0MB heapUsed=40.0MB heapTotal=48.0MB external=9.0MB arrayBuffers=1.0MB',
    'dong rac khong phai log',
    '[MEM] t=2026-10-21T10:00:30.000Z uptime=60s pid=1 rss=90.0MB heapUsed=50.0MB heapTotal=58.0MB external=9.0MB arrayBuffers=1.0MB'
].join('\n');
var parsed = memStats.parse(sample);
assert.strictEqual(parsed.length, 2);
assert.strictEqual(parsed[0].rss, 80);
assert.strictEqual(parsed[1].heapUsed, 50);
assert.strictEqual(parsed[1].uptime, 60);

// 5) summarize() dung voi so mau le va chan.
assert.deepStrictEqual(memStats.summarize([10, 20, 30]), { count: 3, mean: 20, median: 20, min: 10, max: 30 });
assert.deepStrictEqual(memStats.summarize([10, 20, 30, 40]), { count: 4, mean: 25, median: 25, min: 10, max: 40 });
assert.strictEqual(memStats.summarize([]), null);

// 6) report() co tinh RAM con lai theo 512 MB.
var rep = memStats.report(parsed, 0);
assert.ok(/512 MB - RSS trung vị/.test(rep), rep);
assert.ok(/85\.0 MB/.test(rep), rep); // trung vi cua 80 va 90

// 7) sizeReport() liet ke duoc file JSON lon nhat (chan doan OOM).
var DATA = require('../lib/datastore');
DATA.init().then(function () {
    return DATA.sizeReport(3);
}).then(function (rows) {
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length <= 3);
    rows.forEach(function (r) {
        assert.strictEqual(typeof r.key, 'string');
        assert.ok(r.bytes >= 0);
    });
    console.log('PASS: mem-monitor tests');
}).catch(function (err) {
    console.error(err);
    process.exit(1);
});
