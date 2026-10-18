'use strict';
/**
 * lib/import-sessions.js
 * ---------------------------------------------------------------------------
 * Luu tam ket qua phan tich file nhap de xem truoc.
 *
 * Ly do ton tai:
 *   - Anh duoc nhung base64 trong cau hoi. Neu client gui lai toan bo base64
 *     khi bam "Xac nhan" thi payload rat lon. Thay vao do, server giu anh trong
 *     phien va chi tra ve "token" ([[IMG:0]]); client gui lai token.
 *   - Phien chi nam trong RAM, co thoi han (TTL) va tu dong don -> KHONG luu
 *     file tam vo thoi han, khong dung dia.
 *
 * Luu y: chay 1 instance (Socket.IO dang la in-memory) nen RAM la du.
 */

var DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 phut

var state = {
    sessions: {},   // id -> { createdAt, touchedAt, payload }
    ttlMs: DEFAULT_TTL_MS,
    timer: null,
    seq: 0
};

function now() { return Date.now(); }

function newId() {
    state.seq += 1;
    return 'imp_' + now().toString(36) + '_' + state.seq.toString(36) +
        '_' + Math.random().toString(36).slice(2, 10);
}

function sweep() {
    var t = now();
    var keys = Object.keys(state.sessions);
    for (var i = 0; i < keys.length; i++) {
        var s = state.sessions[keys[i]];
        if (!s || (t - s.touchedAt) > state.ttlMs) {
            delete state.sessions[keys[i]];
        }
    }
}

function startSweeper() {
    if (state.timer) return;
    state.timer = setInterval(sweep, 5 * 60 * 1000);
    if (state.timer.unref) state.timer.unref(); // khong giu process song
}

module.exports = {
    create: function (payload) {
        startSweeper();
        var id = newId();
        var t = now();
        state.sessions[id] = { createdAt: t, touchedAt: t, payload: payload };
        return id;
    },

    get: function (id) {
        if (!id) return null;
        var s = state.sessions[id];
        if (!s) return null;
        if ((now() - s.touchedAt) > state.ttlMs) {
            delete state.sessions[id];
            return null;
        }
        s.touchedAt = now();
        return s.payload;
    },

    remove: function (id) {
        if (id && state.sessions[id]) delete state.sessions[id];
    },

    count: function () {
        return Object.keys(state.sessions).length;
    },

    sweep: sweep,

    clearAll: function () {
        state.sessions = {};
    }
};
