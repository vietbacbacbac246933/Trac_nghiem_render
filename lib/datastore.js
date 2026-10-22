'use strict';
/**
 * lib/datastore.js
 * ---------------------------------------------------------------------------
 * Lop luu tru cho ung dung Trac Nghiem.
 *
 * Muc tieu: giu nguyen 100% code nghiep vu dang doc/ghi file JSON trong
 * thu muc data/, nhung thay backend luu tru:
 *   - Neu co bien moi truong DATABASE_URL  -> dung PostgreSQL (Render managed DB)
 *   - Neu khong co                         -> dung filesystem (chay local nhu cu)
 *
 * Cach dung (giong nhu fs readFileSync/writeFileSync nhung an toan hon):
 *   DATA.readJson(absPath, fallback)  -> doc JSON (tu cache trong RAM)
 *   DATA.writeJson(absPath, value)    -> cap nhat cache + ghi nen (async, queued)
 *   DATA.exists(absPath)              -> kiem tra ton tai
 *   DATA.del(absPath)                 -> xoa
 *   DATA.listJsonNames(absDir)        -> liet ke ten file .json trong thu muc
 *
 * Chi cac file .json nam trong thu muc `data/` cua du an moi duoc quan ly.
 * Cac file nhi phan (mau .docx, file Excel danh sach lop) van nam tren dia
 * va duoc doc bang fs that.
 */

var fs = require('fs');
var path = require('path');
var assets = require('./assets');

var APP_ROOT = path.resolve(__dirname, '..');
var DATA_ROOT = path.join(APP_ROOT, 'data');
var UPLOAD_ROOT = path.join(DATA_ROOT, 'uploads');

var state = {
    mode: 'filesystem', // 'filesystem' | 'postgres'
    pool: null,
    cache: {},          // relKey ('data/....json') -> value
    chain: Promise.resolve()
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toRelKey(absPath) {
    return path.relative(APP_ROOT, absPath).split(path.sep).join('/');
}

function isManaged(absPath) {
    var rel = toRelKey(absPath);
    return rel === 'data' || rel.indexOf('data/') === 0;
}

function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function enqueue(op) {
    state.chain = state.chain.then(op).catch(function (err) {
        console.error('[STORE] Loi ghi du lieu:', err && err.message);
    });
    return state.chain;
}

function ensureDirSync(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Ghi file atomic: ghi .tmp roi rename
function fsPutSync(absPath, value) {
    ensureDirSync(path.dirname(absPath));
    var tmp = absPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, absPath);
}

// Quet toan bo data/**/*.json tren dia
function scanDisk() {
    var out = [];
    function walk(dir) {
        var entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && /\.json$/.test(entry.name)) {
                out.push(full);
            }
        }
    }
    walk(DATA_ROOT);
    return out;
}

function loadDiskIntoSync() {
    var files = scanDisk();
    var loaded = 0;
    files.forEach(function (abs) {
        try {
            state.cache[toRelKey(abs)] = JSON.parse(fs.readFileSync(abs, 'utf8'));
            loaded++;
        } catch (e) {
            console.error('[STORE] Bo qua file JSON loi:', abs, e.message);
        }
    });
    console.log('[STORE] Filesystem: da nap ' + loaded + ' file JSON tu data/');
}

// ---------------------------------------------------------------------------
// PostgreSQL backend
// ---------------------------------------------------------------------------
function useSsl(url) {
    if (/sslmode=disable/i.test(url)) return false;
    if (/@(localhost|127\.0\.0\.1)/i.test(url)) return false;
    return { rejectUnauthorized: false };
}

function pgPut(key, value) {
    return state.pool.query(
        'INSERT INTO quiz_kv (key, value, updated_at) VALUES ($1, $2, now()) ' +
        'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        [key, JSON.stringify(value)]
    );
}

function pgDel(key) {
    return state.pool.query('DELETE FROM quiz_kv WHERE key = $1', [key]);
}

function pgAssetTable() {
    return state.pool.query(
        'CREATE TABLE IF NOT EXISTS quiz_assets (' +
        '  id text PRIMARY KEY,' +
        '  data bytea NOT NULL,' +
        '  created_at timestamptz NOT NULL DEFAULT now()' +
        ')'
    );
}

function seedFromDisk() {
    var files = scanDisk();
    var count = 0;
    files.forEach(function (abs) {
        try {
            var rel = toRelKey(abs);
            var value = JSON.parse(fs.readFileSync(abs, 'utf8'));
            state.cache[rel] = value;
            enqueue(function () { return pgPut(rel, value); });
            count++;
        } catch (e) {
            console.error('[STORE] Seed bo qua file loi:', abs, e.message);
        }
    });
    console.log('[STORE] PostgreSQL trong -> da seed ' + count + ' ban ghi tu data/');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
var DATA = {
    get mode() { return state.mode; },

    init: function () {
        var url = process.env.DATABASE_URL;
        if (!url) {
            state.mode = 'filesystem';
            loadDiskIntoSync();
            console.log('[STORE] Che do: filesystem (khong co DATABASE_URL)');
            return Promise.resolve(state.mode);
        }

        var pg;
        try {
            pg = require('pg');
        } catch (e) {
            console.error('[STORE] Khong tim thay module "pg" -> quay ve filesystem');
            state.mode = 'filesystem';
            loadDiskIntoSync();
            return Promise.resolve(state.mode);
        }

        state.pool = new pg.Pool({
            connectionString: url,
            ssl: useSsl(url),
            max: Number(process.env.PG_POOL_MAX || 5)
        });

        return state.pool.query(
            'CREATE TABLE IF NOT EXISTS quiz_kv (' +
            '  key text PRIMARY KEY,' +
            '  value jsonb NOT NULL,' +
            '  updated_at timestamptz NOT NULL DEFAULT now()' +
            ')'
        ).then(function () {
            return pgAssetTable();
        }).then(function () {
            return state.pool.query('SELECT key, value FROM quiz_kv');
        }).then(function (res) {
            state.mode = 'postgres';
            if (res.rows.length === 0) {
                seedFromDisk();
            } else {
                res.rows.forEach(function (row) { state.cache[row.key] = row.value; });
                console.log('[STORE] PostgreSQL: da nap ' + res.rows.length + ' ban ghi');
            }
            return state.mode;
        }).catch(function (err) {
            console.error('[STORE] Loi ket noi PostgreSQL: ' + err.message);
            console.error('[STORE] Tam thoi dung filesystem. Kiem tra DATABASE_URL.');
            state.mode = 'filesystem';
            state.pool = null;
            loadDiskIntoSync();
            return state.mode;
        });
    },

    readJson: function (absPath, fallback) {
        if (!isManaged(absPath)) {
            try { return JSON.parse(fs.readFileSync(absPath, 'utf8')); }
            catch (e) { return fallback; }
        }
        var rel = toRelKey(absPath);
        if (has(state.cache, rel)) return state.cache[rel];
        return fallback;
    },

    writeJson: function (absPath, value) {
        var rel = toRelKey(absPath);
        state.cache[rel] = value;
        if (state.mode === 'postgres') {
            enqueue(function () { return pgPut(rel, value); });
        } else {
            enqueue(function () { fsPutSync(absPath, value); });
        }
    },

    del: function (absPath) {
        var rel = toRelKey(absPath);
        delete state.cache[rel];
        if (state.mode === 'postgres') {
            enqueue(function () { return pgDel(rel); });
        } else {
            enqueue(function () {
                try { fs.unlinkSync(absPath); } catch (e) { /* ignore */ }
            });
        }
    },

    exists: function (absPath) {
        if (isManaged(absPath) && has(state.cache, toRelKey(absPath))) return true;
        return fs.existsSync(absPath);
    },

    listJsonNames: function (absDir) {
        var names = {};
        var relDir = toRelKey(absDir);
        var prefix = relDir + '/';
        Object.keys(state.cache).forEach(function (key) {
            if (key.indexOf(prefix) === 0) {
                var rest = key.slice(prefix.length);
                if (rest.indexOf('/') === -1 && /\.json$/.test(rest)) names[rest] = true;
            }
        });
        try {
            fs.readdirSync(absDir).forEach(function (n) {
                if (/\.json$/.test(n)) names[n] = true;
            });
        } catch (e) { /* thu muc chua ton tai */ }
        return Object.keys(names);
    },

    // -----------------------------------------------------------------------
    // Anh tai len: luu nhi phan, khong base64, khong chi nam trong RAM.
    // -----------------------------------------------------------------------
    saveAsset: function (id, buffer) {
        if (!assets.isAssetId(id) || !Buffer.isBuffer(buffer) || !buffer.length) {
            return Promise.reject(new Error('Asset khong hop le'));
        }
        if (state.mode === 'postgres' && state.pool) {
            return state.pool.query(
                'INSERT INTO quiz_assets (id, data) VALUES ($1, $2)',
                [id, buffer]
            );
        }
        ensureDirSync(UPLOAD_ROOT);
        return new Promise(function (resolve, reject) {
            fs.writeFile(path.join(UPLOAD_ROOT, id), buffer, function (err) {
                if (err) reject(err); else resolve();
            });
        });
    },

    readAsset: function (id) {
        if (!assets.isAssetId(id)) return Promise.resolve(null);
        if (state.mode === 'postgres' && state.pool) {
            return state.pool.query('SELECT data FROM quiz_assets WHERE id = $1', [id])
                .then(function (res) {
                    return res.rows.length ? res.rows[0].data : null;
                })
                .catch(function () { return null; });
        }
        return new Promise(function (resolve) {
            fs.readFile(path.join(UPLOAD_ROOT, id), function (err, buffer) {
                resolve(err ? null : buffer);
            });
        });
    },

    deleteAsset: function (id) {
        if (!assets.isAssetId(id)) return Promise.resolve();
        if (state.mode === 'postgres' && state.pool) {
            return state.pool.query('DELETE FROM quiz_assets WHERE id = $1', [id]).catch(function () {});
        }
        return new Promise(function (resolve) {
            fs.unlink(path.join(UPLOAD_ROOT, id), function () { resolve(); });
        });
    },

    flush: function () {
        return state.chain;
    },

    // Kich thuoc du lieu dang giu trong cache - de tim file JSON phinh to.
    // Postgres: chi doc kich thuoc cot, khong keo du lieu ve Node.
    // Filesystem: doc kich thuoc file. Tra ve toi da `limit` muc lon nhat.
    sizeReport: function (limit) {
        var n = limit || 10;
        if (state.mode === 'postgres' && state.pool) {
            return state.pool.query(
                'SELECT key, pg_column_size(value) AS bytes FROM quiz_kv' +
                ' ORDER BY pg_column_size(value) DESC LIMIT $1', [n]
            ).then(function (res) {
                return res.rows.map(function (r) {
                    return { key: r.key, bytes: Number(r.bytes) || 0 };
                });
            }).catch(function () { return []; });
        }
        var out = [];
        (function walk(dir) {
            var entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (var i = 0; i < entries.length; i++) {
                var p = path.join(dir, entries[i].name);
                if (entries[i].isDirectory()) { walk(p); continue; }
                if (!/\.json$/i.test(entries[i].name)) continue;
                try {
                    out.push({
                        key: path.relative(APP_ROOT, p).replace(/\\/g, '/'),
                        bytes: fs.statSync(p).size
                    });
                } catch (e2) { /* ignore */ }
            }
        })(DATA_ROOT);
        out.sort(function (a, b) { return b.bytes - a.bytes; });
        return Promise.resolve(out.slice(0, n));
    }
};

module.exports = DATA;
