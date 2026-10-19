// Chuan hoa va so sanh dap an cau hoi tra loi ngan (so nguyen/thap phan).
// Khong dung so thuc: tach thanh (dau, chu so nguyen, so chu so thap phan).
// '-'/'+' o dau; ',' va '.' deu la dau thap phan; toi da mot dau thap phan.
var MAX_LEN = 50;

function parse(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    var s = String(value).trim();
    if (!s || s.length > MAX_LEN) return null;
    s = s.replace(',', '.');
    var m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m) return null;
    var intPart = m[2] || '';
    var frac = m[3] || '';
    if (!intPart && !frac) return null; // chi co dau am / dau thap phan
    intPart = intPart.replace(/^0+/, '') || '0';
    frac = frac.replace(/0+$/, '');     // 2.50 === 2.5
    var negative = m[1] === '-' && !(intPart === '0' && frac === '');
    return {
        negative: negative,
        digits: BigInt(intPart + frac),
        scale: frac.length
    };
}

// Dua ve chuoi chuan (vd "2,50" -> "2.5") de luu va hien thi.
function normalize(value) {
    var p = parse(value);
    if (!p) return null;
    var digits = p.digits.toString();
    var intPart, frac;
    if (p.scale === 0) {
        intPart = digits;
        frac = '';
    } else {
        digits = digits.padStart(p.scale + 1, '0');
        intPart = digits.slice(0, digits.length - p.scale);
        frac = digits.slice(digits.length - p.scale);
    }
    intPart = intPart.replace(/^0+/, '') || '0';
    return (p.negative ? '-' : '') + intPart + (frac ? '.' + frac : '');
}

function equals(a, b) {
    var x = parse(a);
    var y = parse(b);
    if (!x || !y) return false;
    if (x.negative !== y.negative) return false;
    if (x.scale === y.scale) return x.digits === y.digits;
    if (x.scale < y.scale) return x.digits * (10n ** BigInt(y.scale - x.scale)) === y.digits;
    return x.digits === y.digits * (10n ** BigInt(x.scale - y.scale));
}

module.exports = { parse: parse, normalize: normalize, equals: equals };
