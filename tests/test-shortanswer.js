// Kiem thu chuan hoa / so sanh dap an tra loi ngan (khong can khoi dong server).
var assert = require('assert');
var sa = require('../lib/short-answer');

var norm = sa.normalize;
var eq = sa.equals;

// Hop le
assert.strictEqual(norm('12'), '12');
assert.strictEqual(norm('-12'), '-12');
assert.strictEqual(norm('2.5'), '2.5');
assert.strictEqual(norm('2,5'), '2.5');
assert.strictEqual(norm('-2.5'), '-2.5');
assert.strictEqual(norm('-2,5'), '-2.5');
assert.strictEqual(norm('  +007.50 '), '7.5');
assert.strictEqual(norm('.5'), '0.5');
assert.strictEqual(norm('-0.0'), '0');

// Khong hop le
assert.strictEqual(norm(''), null);
assert.strictEqual(norm('   '), null);
assert.strictEqual(norm('-'), null);
assert.strictEqual(norm('.'), null);
assert.strictEqual(norm(','), null);
assert.strictEqual(norm('2.5.6'), null);
assert.strictEqual(norm('2,5,6'), null);
assert.strictEqual(norm('2 5'), null);
assert.strictEqual(norm('abc'), null);
assert.strictEqual(norm('2a'), null);
assert.strictEqual(norm('--2'), null);
assert.strictEqual(norm('2-'), null);
assert.strictEqual(norm('1e3'), null);

// So sanh chinh xac (khong sai so float)
assert.strictEqual(eq('2,5', '2.5'), true);
assert.strictEqual(eq('-2,5', '-2.5'), true);
assert.strictEqual(eq('2.50', '2.5'), true);
assert.strictEqual(eq('0.1', '0.10'), true);
assert.strictEqual(eq('2.5', '3.5'), false);
assert.strictEqual(eq('2.5', '-2.5'), false);
assert.strictEqual(eq('', '0'), false);
assert.strictEqual(eq('abc', '0'), false);
assert.strictEqual(eq('0.30000000000000004', '0.3'), false);
assert.strictEqual(eq('123456789012345678901234567890.1', '123456789012345678901234567890.10'), true);

console.log('PASS: short-answer tests');
