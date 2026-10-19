// Doc bang dap an o cuoi file Word (mammoth tra ve HTML) va ghep vao cau hoi.
// Khong dung regex de hieu cau truc bang: chi dung regex de tim <table>, con lai
// parse DOM + mo rong colspan/rowspan de ho tro o gop va nhieu cum cot.
var shortAnswer = require('./short-answer');
var DOMParser = require('xmldom').DOMParser;

var TYPE_LABEL = {
    single: 'Trắc nghiệm nhiều lựa chọn',
    truefalse: 'Trắc nghiệm Đúng/Sai',
    shortanswer: 'Trả lời ngắn'
};

function stripTags(html) {
    return String(html || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/(?:p|div|li|tr|td|th)>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// Bo dau tieng Viet + lowercase de so khop tieu de on dinh.
function normKey(text) {
    return stripTags(text)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

var ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function romanToNumber(s) {
    var total = 0, prev = 0;
    for (var i = s.length - 1; i >= 0; i--) {
        var v = ROMAN[s.charAt(i)];
        if (!v) return null;
        if (v < prev) total -= v; else { total += v; prev = v; }
    }
    return total > 0 ? total : null;
}

// "III" va "3" cung tra ve "3" de so khop tieu de bang voi tieu de phan.
function sectionKey(label) {
    if (label == null) return null;
    var s = String(label).trim().toUpperCase();
    if (!s) return null;
    if (/^\d+$/.test(s)) return String(parseInt(s, 10));
    if (/^[IVXLCDM]+$/.test(s)) {
        var n = romanToNumber(s.toLowerCase());
        return n ? String(n) : s;
    }
    return s;
}

function titleInfo(text) {
    var raw = stripTags(text);
    var k = normKey(raw);
    // Chi coi la tieu de bang dap an khi bat dau bang "ĐÁP ÁN"/"BẢNG ĐÁP ÁN"
    // hoac "PHẦN ... ĐÁP ÁN". Tranh nham cau hoi "Chọn đáp án đúng" nam ngay
    // truoc mot bang thong thuong.
    var startsAnswer = /^(?:\d+[\.\)]\s*)?(?:bang\s+)?dap an\b/.test(k);
    var sectionAnswer = /^phan\b/.test(k) && k.indexOf('dap an') >= 0;
    if (!startsAnswer && !sectionAnswer) return null;
    var type = null;
    if (/tra loi ngan/.test(k)) type = 'shortanswer';
    else if (/dung\s*[-\/]?\s*sai/.test(k)) type = 'truefalse';
    else if (/trac nghiem/.test(k)) type = 'single';
    var m = k.match(/phan\s+([ivxlcdm]+|\d+)/);
    return {
        title: raw,
        type: type,
        sectionKey: m ? sectionKey(m[1]) : null,
        sectionLabel: m ? String(m[1]).toUpperCase() : null
    };
}

function directChildren(node, tag) {
    var out = [];
    for (var n = node && node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1 && String(n.localName || n.nodeName).toLowerCase() === tag) out.push(n);
    }
    return out;
}

function nodeText(node) {
    var out = '';
    for (var n = node && node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 || n.nodeType === 4) {
            out += n.nodeValue || '';
        } else if (n.nodeType === 1) {
            var tag = String(n.localName || n.nodeName).toLowerCase();
            var pad = (tag === 'p' || tag === 'div' || tag === 'br' || tag === 'li') ? ' ' : '';
            out += pad + nodeText(n) + pad;
        }
    }
    return out;
}

function spanAttr(node, name) {
    var raw = node.getAttribute && node.getAttribute(name);
    var n = parseInt(raw, 10);
    if (!isFinite(n) || n < 1) return 1;
    return Math.min(n, 100);
}

// Tra ve grid[r][c] = cell, trong do o gop duoc mo rong de moi dong/cot deu
// doc duoc gia tri cua o goc (rowspan/colspan).
function parseTable(tableHtml) {
    var dom;
    try {
        dom = new DOMParser({
            errorHandler: { warning: function () { }, error: function () { }, fatalError: function () { } }
        }).parseFromString(tableHtml, 'text/xml');
    } catch (e) {
        return null;
    }
    var table = dom && dom.getElementsByTagName('table')[0];
    if (!table) return null;

    var trs = directChildren(table, 'tr');
    if (!trs.length) return null;

    var grid = [];
    var rows = [];
    var rowCount = 0;
    var colCount = 0;

    trs.forEach(function (tr, r) {
        var cells = [];
        var col = 0;
        var tds = [];
        for (var n = tr.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1) {
                var tag = String(n.localName || n.nodeName).toLowerCase();
                if (tag === 'td' || tag === 'th') tds.push(n);
            }
        }
        tds.forEach(function (td) {
            while (grid[r] && grid[r][col]) col++;
            var cs = spanAttr(td, 'colspan');
            var rs = spanAttr(td, 'rowspan');
            var cell = {
                text: stripTags(nodeText(td)),
                row: r,
                col: col,
                colspan: cs,
                rowspan: rs
            };
            cells.push(cell);
            for (var rr = r; rr < r + rs; rr++) {
                grid[rr] = grid[rr] || [];
                for (var cc = col; cc < col + cs; cc++) grid[rr][cc] = cell;
            }
            col += cs;
            colCount = Math.max(colCount, col);
            rowCount = Math.max(rowCount, r + rs);
        });
        rows[r] = { cells: cells };
    });

    return { rows: rows, grid: grid, rowCount: rowCount, colCount: colCount };
}

function gridText(grid, r, c) {
    var cell = grid[r] && grid[r][c];
    return cell ? cell.text : '';
}

function isAnswerHeader(t) {
    var k = normKey(t);
    return /dap an|answer/.test(k);
}
function isQuestionHeader(t) {
    var k = normKey(t);
    return /^(cau(\s+(hoi|so))?|stt|so thu tu|so cau|so tt)(\s+\d+)?$/.test(k);
}
function isPartHeader(t) {
    var k = normKey(t);
    return /^(lenh hoi|y|y kien|menh de|phat bieu|noi dung)$/.test(k);
}

// Xac dinh cac cum cot "Câu - [Lệnh hỏi] - Đáp án" hoac bang ngang "Câu | 1 | 2".
function detectLayout(parsed) {
    var header = (parsed.rows[0] && parsed.rows[0].cells || []).filter(function (c) { return c.text; });
    if (!header.length) return null;

    var answerHeaders = header.filter(function (c) { return isAnswerHeader(c.text); });
    var groups = [];

    if (answerHeaders.length) {
        var qHeaders = header.filter(function (c) { return isQuestionHeader(c.text); });
        var used = [];
        answerHeaders.forEach(function (ah) {
            var q = null;
            for (var i = qHeaders.length - 1; i >= 0; i--) {
                if (qHeaders[i].col < ah.col && used.indexOf(qHeaders[i].col) < 0) {
                    q = qHeaders[i];
                    break;
                }
            }
            if (!q) return;
            used.push(q.col);
            var part = null;
            header.forEach(function (h) {
                if (h.col > q.col && h.col < ah.col && (isPartHeader(h.text) || /^[a-d]$/i.test(h.text))) {
                    if (!part || h.col > part.col) part = h;
                }
            });
            groups.push({ qCol: q.col, aCol: ah.col, partCol: part ? part.col : null });
        });

        if (groups.length) {
            // Header co the chiem nhieu dong (rowspan), du lieu bat dau sau dong cuoi cua header.
            var dataStart = 1;
            header.forEach(function (c) { dataStart = Math.max(dataStart, c.row + c.rowspan); });
            return { kind: 'columns', groups: groups, dataStart: dataStart };
        }
    }

    // Bang ngang: dong dau "Câu | 1 | 2 | 3", dong sau "Đáp án | A | C | B".
    var first = header[0];
    if (first && isQuestionHeader(first.text)) {
        var numberHeaders = header.filter(function (c) { return /^\d{1,3}$/.test(c.text); });
        var answerRow = -1;
        for (var r = 1; r < parsed.rowCount; r++) {
            var t = gridText(parsed.grid, r, first.col);
            if (isAnswerHeader(t)) { answerRow = r; break; }
        }
        if (numberHeaders.length && answerRow > 0) {
            return {
                kind: 'horizontal',
                answerRow: answerRow,
                pairs: numberHeaders.map(function (h) { return { number: parseInt(h.text, 10), col: h.col }; })
            };
        }

        // Dang Đúng/Sai ngang: "Câu | a | b | c | d".
        var partHeaders = header.filter(function (c) { return /^[a-d]$/i.test(c.text); });
        if (partHeaders.length) {
            return {
                kind: 'parts',
                qCol: first.col,
                dataStart: 1,
                partColumns: partHeaders.map(function (h) { return { col: h.col, part: h.text.toLowerCase().charCodeAt(0) - 97 }; })
            };
        }
    }

    // Bang 2 cot khong co dong tieu de: "1 | A", "2 | C".
    if (parsed.colCount === 2) {
        var nums = 0, ok = true;
        for (var rr = 0; rr < parsed.rowCount; rr++) {
            var a = gridText(parsed.grid, rr, 0).trim();
            var b = gridText(parsed.grid, rr, 1).trim();
            if (!a && !b) continue;
            if (/^\d{1,3}$/.test(a)) nums++;
            else ok = false;
        }
        if (ok && nums) {
            return { kind: 'columns', groups: [{ qCol: 0, aCol: 1, partCol: null }], dataStart: 0 };
        }
    }
    return null;
}

function parseQuestionNumber(text) {
    var m = String(text || '').match(/(?:cau\s*)?(\d{1,3})/i);
    return m ? parseInt(m[1], 10) : null;
}

function parsePart(text) {
    var s = normKey(text).replace(/[^a-z0-9]/g, '');
    if (/^[a-d]$/.test(s)) return s.charCodeAt(0) - 97;
    if (/^[1-4]$/.test(s)) return parseInt(s, 10) - 1;
    return null;
}

function buildEntries(parsed, layout, typeHint) {
    var entries = [];
    var warnings = [];

    if (layout.kind === 'horizontal') {
        layout.pairs.forEach(function (p) {
            var value = gridText(parsed.grid, layout.answerRow, p.col).trim();
            entries.push({ number: p.number, part: null, value: value, row: layout.answerRow });
        });
        return { entries: entries, warnings: warnings };
    }

    if (layout.kind === 'parts') {
        for (var rp = layout.dataStart; rp < parsed.rowCount; rp++) {
            var number = parseQuestionNumber(gridText(parsed.grid, rp, layout.qCol).trim());
            if (!number) continue;
            layout.partColumns.forEach(function (pc) {
                entries.push({
                    number: number,
                    part: pc.part,
                    value: gridText(parsed.grid, rp, pc.col).trim(),
                    row: rp
                });
            });
        }
        return { entries: entries, warnings: warnings };
    }

    layout.groups.forEach(function (g, gi) {
        var lastQ = null;
        var partCursor = 0;
        for (var r = layout.dataStart; r < parsed.rowCount; r++) {
            var qText = gridText(parsed.grid, r, g.qCol).trim();
            var aText = gridText(parsed.grid, r, g.aCol).trim();
            var pText = g.partCol != null ? gridText(parsed.grid, r, g.partCol).trim() : '';

            if (qText) {
                if (qText !== lastQ) {
                    lastQ = qText;
                    partCursor = 0;
                }
            } else {
                qText = lastQ || '';
            }

            if (!qText && !aText && !pText) continue;

            var number = parseQuestionNumber(qText);
            if (!number) {
                if (qText) warnings.push('Không đọc được số câu "' + qText.slice(0, 30) + '" trong bảng đáp án.');
                continue;
            }

            var part = pText ? parsePart(pText) : null;
            if (pText && part === null) {
                warnings.push('Không đọc được ý "' + pText.slice(0, 20) + '" của câu ' + number + '.');
            }
            if (part === null && !pText) {
                part = typeHint === 'truefalse' ? partCursor : null;
            }
            if (pText || typeHint === 'truefalse') partCursor++;

            entries.push({ number: number, part: part, value: aText, row: r, group: gi });
        }
    });

    return { entries: entries, warnings: warnings };
}

function inferType(entries) {
    var vals = entries.map(function (e) { return e.value; }).filter(function (v) { return v; });
    if (!vals.length) return null;
    // Co "S/Sai" thi gan nhu chac chan la Dung/Sai; "D" mot minh co the la lua chon D.
    var tfLike = vals.every(function (v) { return /^(d|s|dung|sai|true|false)$/.test(normKey(v)); });
    var hasFalse = vals.some(function (v) { return /^(s|sai|false)$/.test(normKey(v)); });
    if (tfLike && hasFalse) return 'truefalse';
    if (vals.every(function (v) { return /^[A-Za-z]$/.test(v.trim()); })) return 'single';
    if (tfLike) return 'truefalse';
    if (vals.every(function (v) { return shortAnswer.normalize(v) !== null; })) return 'shortanswer';
    return null;
}

function tfValue(v) {
    var k = normKey(v);
    if (/^(d|dung|true|t|1|co|yes)$/.test(k)) return true;
    if (/^(s|sai|false|f|0|khong|no)$/.test(k)) return false;
    return null;
}

function choiceLetters(v) {
    var s = String(v || '').trim().toUpperCase()
        .replace(/^[\s(\[{]+/, '').replace(/[\s.,;:)\]}]+$/, '');
    if (!/^[A-Z](?:\s*[,;\/]\s*[A-Z])*$/.test(s)) return null;
    return s.replace(/[^A-Z]/g, '').split('');
}

function addReason(q, reason) {
    if (!q.reviewReasons) q.reviewReasons = [];
    if (q.reviewReasons.indexOf(reason) < 0) q.reviewReasons.push(reason);
}
// Canh bao rieng, khong bi computeImportReview() o giao dien xoa khi sua dap an.
function addAnswerWarning(q, warning) {
    if (!q.answerWarnings) q.answerWarnings = [];
    if (q.answerWarnings.indexOf(warning) < 0) q.answerWarnings.push(warning);
}
function removeReason(q, re) {
    if (!q.reviewReasons) return;
    q.reviewReasons = q.reviewReasons.filter(function (r) { return !re.test(r); });
}
function refreshReview(q) {
    if (q.reviewReasons) q.needsReview = q.reviewReasons.length > 0;
}

function uniqueSections(questions) {
    var seen = {};
    questions.forEach(function (q) {
        var key = q.importMeta && q.importMeta.sectionIndex != null ? q.importMeta.sectionIndex : -1;
        seen[key] = true;
    });
    return Object.keys(seen);
}

function pickTargets(questions, table, type) {
    if (table.sectionKey) {
        var bySection = questions.filter(function (q) {
            return q.importMeta && q.importMeta.sectionKey === table.sectionKey;
        });
        return { questions: bySection, warning: bySection.length ? null : 'Không tìm thấy phần ' + table.sectionLabel + ' trong đề.' };
    }
    if (type) {
        var byType = questions.filter(function (q) { return (q.type || 'single') === type; });
        if (!byType.length) {
            return { questions: [], warning: 'Không tìm thấy câu hỏi ' + (TYPE_LABEL[type] || type) + ' để ghép đáp án.' };
        }
        var secs = uniqueSections(byType);
        if (secs.length > 1) {
            return { questions: [], warning: 'Có nhiều phần cùng loại "' + (TYPE_LABEL[type] || type) + '" — không tự ghép để tránh nhầm. Hãy đặt tiêu đề bảng có "PHẦN ...".' };
        }
        return { questions: byType, warning: null };
    }
    return { questions: [], warning: 'Không xác định được loại câu hỏi của bảng đáp án.' };
}

function apply(questions, tables) {
    var report = { tables: [], warnings: [] };

    tables.forEach(function (table) {
        var layout = detectLayout(table.parsed);
        if (!layout) {
            report.tables.push({ title: table.title, type: table.type, applied: 0, entries: 0, warnings: ['Không đọc được cấu trúc bảng đáp án.'] });
            report.warnings.push('Bảng "' + table.title + '": không đọc được cấu trúc — giáo viên cần nhập đáp án thủ công.');
            return;
        }

        // Loai cau: uu tien tieu de, sau do loai cua phan duoc chi dinh, cuoi cung do gia tri.
        var type = table.type;
        var targets = null;
        if (table.sectionKey) {
            var picked = pickTargets(questions, table, null);
            if (!picked.questions.length) {
                report.tables.push({ title: table.title, type: type, applied: 0, entries: 0, warnings: [picked.warning] });
                report.warnings.push('Bảng "' + table.title + '": ' + picked.warning);
                return;
            }
            if (!type) {
                var q0 = picked.questions[0];
                type = (q0 && (q0.type || 'single')) || 'single';
            }
            targets = picked;
        } else {
            targets = pickTargets(questions, table, type);
            if (!targets.questions.length) {
                if (!type) {
                    // Chua biet loai: thu suy ra tu gia tri bang.
                    var built0 = buildEntries(table.parsed, layout, null);
                    type = inferType(built0.entries);
                    targets = pickTargets(questions, table, type);
                }
            }
        }

        var built = buildEntries(table.parsed, layout, type);
        if (!type) type = inferType(built.entries);
        if (!type) {
            report.tables.push({ title: table.title, type: null, applied: 0, entries: 0, warnings: ['Không xác định được loại đáp án (A/B/C/D, Đ/S hay số).'] });
            report.warnings.push('Bảng "' + table.title + '": không xác định được loại đáp án.');
            return;
        }

        if (!targets || !targets.questions.length) {
            targets = pickTargets(questions, table, type);
        }
        if (!targets.questions.length) {
            report.tables.push({ title: table.title, type: type, applied: 0, entries: built.entries.length, warnings: [targets.warning].filter(Boolean) });
            report.warnings.push('Bảng "' + table.title + '": ' + (targets.warning || 'không ghép được câu hỏi nào.'));
            return;
        }

        var scoped = targets.questions.filter(function (q) { return (q.type || 'single') === type; });
        // Tieu de chi ghi "TRẮC NGHIỆM" nhung ca phan la cau nhieu dap an.
        if (!scoped.length && type === 'single') {
            var multiOnly = targets.questions.filter(function (q) { return q.type === 'multi'; });
            if (multiOnly.length === targets.questions.length && multiOnly.length > 0) {
                type = 'multi';
                scoped = multiOnly;
            }
        }
        if (!scoped.length) {
            report.tables.push({ title: table.title, type: type, applied: 0, entries: built.entries.length, warnings: ['Loại đáp án trong bảng không khớp loại câu hỏi của phần.'] });
            report.warnings.push('Bảng "' + table.title + '": loại đáp án không khớp loại câu hỏi của phần.');
            return;
        }

        var byNumber = {};
        scoped.forEach(function (q, idx) {
            var n = q.importMeta && q.importMeta.number;
            if (n == null) n = idx + 1;
            if (!byNumber[n]) byNumber[n] = [];
            byNumber[n].push(q);
        });

        var tableWarnings = built.warnings.slice();
        var applied = 0;
        var seen = {};

        function markApplied(q) {
            applied++;
            q.answerSource = 'table';
            if (!q.answerTableNotes) q.answerTableNotes = [];
            var note = 'Đáp án lấy từ bảng "' + table.title + '".';
            if (q.answerTableNotes.indexOf(note) < 0) q.answerTableNotes.push(note);
        }

        built.entries.forEach(function (e) {
            var matches = byNumber[e.number] || [];
            if (!matches.length) {
                tableWarnings.push('Đáp án câu ' + e.number + ' không ghép được với câu hỏi nào trong phần.');
                return;
            }
            if (matches.length > 1) {
                tableWarnings.push('Có ' + matches.length + ' câu số ' + e.number + ' trong cùng phần — không tự ghép.');
                matches.forEach(function (q) { addReason(q, 'Có nhiều câu cùng số ' + e.number + ' — kiểm tra đáp án bảng.'); refreshReview(q); });
                return;
            }
            var q = matches[0];
            if (!e.value) {
                tableWarnings.push('Câu ' + e.number + (e.part != null ? ' ý ' + String.fromCharCode(97 + e.part) : '') + ': ô đáp án trống.');
                if (type === 'truefalse') addReason(q, 'Câu ' + e.number + ' ý ' + String.fromCharCode(97 + (e.part || 0)) + ': bảng đáp án để trống.');
                return;
            }

            var key = e.number + ':' + (e.part == null ? '' : e.part);
            if (seen[key] != null) {
                if (seen[key] !== e.value) {
                    var dw = 'Bảng đáp án có nhiều giá trị khác nhau cho câu ' + e.number + (e.part != null ? ' ý ' + String.fromCharCode(97 + e.part) : '') + '.';
                    addReason(q, dw);
                    addAnswerWarning(q, dw);
                    tableWarnings.push('Câu ' + e.number + ': có nhiều đáp án khác nhau trong bảng.');
                }
                refreshReview(q);
                return;
            }
            seen[key] = e.value;

            if (type === 'shortanswer') {
                var norm = shortAnswer.normalize(e.value);
                if (!norm) {
                    addReason(q, 'Đáp án bảng không hợp lệ: "' + e.value.slice(0, 40) + '".');
                    tableWarnings.push('Câu ' + e.number + ': đáp án "' + e.value.slice(0, 30) + '" không phải số hợp lệ.');
                    refreshReview(q);
                    return;
                }
                if (q.answerDetected && q.correctAnswer && q.correctAnswer !== norm) {
                    var sw = 'Đáp án trong bảng (' + norm + ') khác đáp án đã có (' + q.correctAnswer + ') — kiểm tra lại.';
                    addReason(q, sw);
                    addAnswerWarning(q, sw);
                }
                q.correctAnswer = norm;
                q.answerDetected = true;
                removeReason(q, /Chưa có đáp án trả lời ngắn/);
                removeReason(q, /Chưa xác định được đáp án đúng/);
                markApplied(q);
                refreshReview(q);
                return;
            }

            if (type === 'truefalse') {
                var part = e.part;
                if (part == null) {
                    addReason(q, 'Không xác định được ý a/b/c/d cho câu ' + e.number + '.');
                    tableWarnings.push('Câu ' + e.number + ': thiếu cột ý a/b/c/d.');
                    refreshReview(q);
                    return;
                }
                var v = tfValue(e.value);
                if (v === null) {
                    addReason(q, 'Đáp án Đ/S không hợp lệ ở câu ' + e.number + ' ý ' + String.fromCharCode(97 + part) + ': "' + e.value.slice(0, 20) + '".');
                    tableWarnings.push('Câu ' + e.number + ': đáp án "' + e.value.slice(0, 20) + '" không phải Đ/S.');
                    refreshReview(q);
                    return;
                }
                if (!Array.isArray(q.correctTF)) q.correctTF = [];
                var old = q.correctTF[part];
                if ((old === true || old === false) && old !== v) {
                    var tw = 'Đáp án bảng câu ' + e.number + ' ý ' + String.fromCharCode(97 + part) + ' khác đáp án đã có — kiểm tra lại.';
                    addReason(q, tw);
                    addAnswerWarning(q, tw);
                }
                q.correctTF[part] = v;
                markApplied(q);
                refreshReview(q);
                return;
            }

            // single / multi
            var letters = choiceLetters(e.value);
            if (!letters) {
                addReason(q, 'Đáp án bảng không hợp lệ ở câu ' + e.number + ': "' + e.value.slice(0, 20) + '".');
                tableWarnings.push('Câu ' + e.number + ': đáp án "' + e.value.slice(0, 20) + '" không phải A/B/C/D.');
                refreshReview(q);
                return;
            }
            var idxs = letters.map(function (ch) { return ch.charCodeAt(0) - 65; });
            var bad = idxs.filter(function (idx) { return idx < 0 || idx >= (q.options || []).length; });
            if (bad.length) {
                addReason(q, 'Đáp án bảng câu ' + e.number + ' vượt quá số đáp án của câu hỏi.');
                tableWarnings.push('Câu ' + e.number + ': đáp án ' + letters.join('') + ' không có trong các lựa chọn.');
                refreshReview(q);
                return;
            }
            if (type === 'multi') {
                var oldList = Array.isArray(q.correctList) ? q.correctList.slice().sort() : [];
                var newList = idxs.slice().sort();
                if (oldList.length && oldList.join(',') !== newList.join(',')) {
                    var mw = 'Đáp án bảng câu ' + e.number + ' khác đáp án đã có — kiểm tra lại.';
                    addReason(q, mw);
                    addAnswerWarning(q, mw);
                }
                q.correctList = newList;
            } else {
                if (q.answerDetected && q.correct >= 0 && q.correct !== idxs[0]) {
                    var cw = 'Đáp án bảng câu ' + e.number + ' (' + letters[0] + ') khác đáp án đã có — kiểm tra lại.';
                    addReason(q, cw);
                    addAnswerWarning(q, cw);
                }
                q.correct = idxs[0];
            }
            q.answerDetected = true;
            removeReason(q, /Chưa xác định được đáp án đúng/);
            markApplied(q);
            refreshReview(q);
        });

        // Câu hỏi trong phần không có đáp án trong bảng.
        scoped.forEach(function (q) {
            if (q.answerSource === 'table') return;
            if (type === 'truefalse') {
                if (Array.isArray(q.correctTF) && q.correctTF.some(function (v) { return v === true || v === false; })) {
                    addReason(q, 'Bảng đáp án còn thiếu một số ý của câu này.');
                }
                refreshReview(q);
                return;
            }
            if (!q.answerDetected) {
                tableWarnings.push('Câu ' + (q.importMeta && q.importMeta.number != null ? q.importMeta.number : '?') + ' chưa có đáp án trong bảng.');
            }
        });

        // Don cac ly do cu da duoc bang dap an giai quyet.
        scoped.forEach(function (q) {
            if (!q.answerDetected && type !== 'truefalse') return;
            if (type === 'truefalse') {
                var all = (q.options || []).length > 0 && q.options.every(function (_, idx) { return q.correctTF && (q.correctTF[idx] === true || q.correctTF[idx] === false); });
                if (all) {
                    q.answerDetected = true;
                    removeReason(q, /Chưa nhận ra phát biểu nào đúng\/sai/);
                    removeReason(q, /Chưa xác định được đáp án đúng/);
                }
            }
            refreshReview(q);
        });

        report.tables.push({
            title: table.title,
            type: type,
            typeLabel: TYPE_LABEL[type] || type,
            entries: built.entries.length,
            applied: applied,
            warnings: tableWarnings
        });
        tableWarnings.forEach(function (w) { report.warnings.push('Bảng "' + table.title + '": ' + w); });
    });

    return report;
}

// Tach HTML thanh cac block <table> va <p> theo dung thu tu de biet tieu de
// nao nam ngay truoc bang nao.
function extract(html) {
    var tables = [];
    var warnings = [];
    var matches = [];
    var re = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
    var m;
    while ((m = re.exec(html))) matches.push({ start: m.index, end: re.lastIndex, html: m[0] });

    var removals = [];
    matches.forEach(function (block) {
        var before = html.slice(0, block.start);
        // Chi lay <p> CUOI CUNG: [\s\S]*? se an ca cac <p> truoc do va lay sai tieu de.
        var pm = before.match(/<p\b[^>]*>((?:(?!<\/p>)[\s\S])*)<\/p>\s*$/i);
        var caption = pm ? stripTags(pm[1]) : '';
        var parsed = parseTable(block.html);
        if (!parsed) {
            if (normKey(stripTags(block.html).slice(0, 200)).indexOf('dap an') >= 0) {
                warnings.push('Có bảng chứa chữ "Đáp án" nhưng không đọc được cấu trúc.');
            }
            return;
        }

        var info = titleInfo(caption);
        var captionIsTitle = !!info;
        var skipFirstRow = false;
        if (!info && parsed.rows[0] && parsed.rows[0].cells.length === 1) {
            var firstText = parsed.rows[0].cells[0].text;
            if (titleInfo(firstText)) {
                info = titleInfo(firstText);
                skipFirstRow = true;
            }
        }
        if (!info) {
            // Bang co cot "Câu"/"Đáp án" nhung tieu de lai khong bat dau bang
            // "ĐÁP ÁN": canh bao de giao vien biet ma nhap tay, khong tu doan.
            var probe = parsed.rows.slice(0, 2).map(function (row) {
                return (row.cells || []).map(function (c) { return normKey(c.text); }).join(' ');
            }).join(' | ');
            if (/\bcau\b/.test(probe) && /dap an/.test(probe)) {
                warnings.push('Có bảng giống bảng đáp án nhưng tiêu đề không bắt đầu bằng "ĐÁP ÁN" — chưa tự ghép.');
            }
            return; // bảng thường trong nội dung câu hỏi
        }

        if (skipFirstRow) {
            // Bo dong tieu de nam trong bang roi parse lai de danh so dong dung.
            var inner = block.html.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/i, '');
            parsed = parseTable(inner) || parsed;
        }

        // Khong doc duoc cau truc thi giu nguyen noi dung va canh bao, khong
        // tu xoa mot doan co the la dap an dang dong cua cau hoi.
        if (!detectLayout(parsed)) {
            warnings.push('Bảng "' + info.title + '" không đọc được cấu trúc đáp án — giáo viên cần nhập tay.');
            return;
        }

        tables.push({
            title: info.title,
            type: info.type,
            sectionKey: info.sectionKey,
            sectionLabel: info.sectionLabel,
            parsed: parsed
        });

        removals.push({
            start: (captionIsTitle && pm) ? block.start - (before.length - pm.index) : block.start,
            end: block.end
        });
    });

    removals.sort(function (a, b) { return b.start - a.start; });
    var cleaned = html;
    removals.forEach(function (r) {
        cleaned = cleaned.slice(0, r.start) + cleaned.slice(r.end);
    });

    return { cleanedHtml: cleaned, tables: tables, warnings: warnings };
}

module.exports = {
    extract: extract,
    apply: apply,
    sectionKey: sectionKey,
    parseTable: parseTable,
    detectLayout: detectLayout,
    buildEntries: buildEntries,
    inferType: inferType
};
