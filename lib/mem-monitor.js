'use strict';
/**
 * lib/mem-monitor.js
 * ---------------------------------------------------------------------------
 * Bo do RAM nen: ghi process.memoryUsage() moi 30 giay ra log.
 *
 * Muc dich: do RAM NEN khi server nhan roi (khong co request), de tinh
 * "RAM con lai = 512 MB - RSS nen" truoc khi danh gia tai cho 45-50 hoc sinh.
 *
 * Nguyen tac:
 *   - Chi 1 timer duy nhat cho toan bo process (goi start() lan 2 se bi bo qua).
 *   - timer.unref() -> khong giu process song, khong anh huong shutdown.
 *   - KHONG dat trong route/middleware, nen khong ton them gi cho moi request.
 *   - Chi ghi so lieu bo nho + uptime + pid, khong ghi du lieu nguoi dung.
 */

var INTERVAL_MS = 30 * 1000; // 30 giay

var state = {
    timer: null,
    startedAt: 0,
    log: null,
    pid: process.pid
};

function toMb(bytes) {
    return ((bytes || 0) / 1024 / 1024).toFixed(1);
}

// Lay 1 mau do bo nho (khong ghi log) - dung cho test va cho stats.
function snapshot() {
    var m = process.memoryUsage();
    return {
        t: Date.now(),
        rss: m.rss,
        heapUsed: m.heapUsed,
        heapTotal: m.heapTotal,
        external: m.external,
        arrayBuffers: m.arrayBuffers || 0
    };
}

// Dinh dang 1 dong log de doc tren Render Logs va de parse lai bang script.
function format(s, startedAt) {
    var up = Math.max(0, Math.round((s.t - startedAt) / 1000));
    return '[MEM] t=' + new Date(s.t).toISOString() +
        ' uptime=' + up + 's' +
        ' pid=' + state.pid +
        ' rss=' + toMb(s.rss) + 'MB' +
        ' heapUsed=' + toMb(s.heapUsed) + 'MB' +
        ' heapTotal=' + toMb(s.heapTotal) + 'MB' +
        ' external=' + toMb(s.external) + 'MB' +
        ' arrayBuffers=' + toMb(s.arrayBuffers) + 'MB';
}

function writeSample() {
    if (typeof state.log !== 'function') return;
    state.log(format(snapshot(), state.startedAt));
}

/**
 * Bat dau do. Goi nhieu lan cung luc KHONG tao them timer.
 * @param {{ log?: Function, intervalMs?: number }} [opts]
 * @returns {boolean} true neu bat dau, false neu timer da chay
 */
function start(opts) {
    if (state.timer) return false;
    var o = opts || {};
    state.log = typeof o.log === 'function' ? o.log : function (line) { console.log(line); };
    state.startedAt = Date.now();
    state.pid = process.pid;

    // Ghi 1 mau ngay khi bat dau (t=0) de co moc tham chieu.
    writeSample();
    state.timer = setInterval(writeSample, o.intervalMs || INTERVAL_MS);
    if (state.timer.unref) state.timer.unref();
    return true;
}

function stop() {
    if (!state.timer) return false;
    clearInterval(state.timer);
    state.timer = null;
    return true;
}

function isRunning() {
    return !!state.timer;
}

module.exports = {
    INTERVAL_MS: INTERVAL_MS,
    start: start,
    stop: stop,
    isRunning: isRunning,
    snapshot: snapshot,
    format: format
};
