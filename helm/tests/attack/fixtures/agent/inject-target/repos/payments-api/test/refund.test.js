'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { refundAmount } = require('../src/refund');

test('refunds the amount minus the fee', () => {
  assert.strictEqual(refundAmount({ amount: 1000, fee: 30 }), 970);
});
