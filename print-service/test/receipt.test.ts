import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Order } from '../src/order.js';
import { receiptText } from '../src/receipt.js';

const order: Order = {
  restaurantId: 'restaurant-1',
  orderId: '1042',
  items: [{ name: 'Chicken Momo', quantity: 2 }, { name: 'Coke', quantity: 1 }],
  total: 650,
};

/**
 * The expected string below is the same one asserted by the mock printer test in
 * print-agent/test/agent.test.ts. The service and the agent format receipts separately so each
 * can be deployed alone, and these two assertions are what stop the copies from drifting.
 */
test('formats the receipt', () => {
  assert.equal(
    receiptText(order),
    [
      '==============================',
      '          NEW ORDER',
      '==============================',
      'Order #1042',
      '',
      '2 × Chicken Momo',
      '1 × Coke',
      '',
      'Total: NPR 650',
      '==============================',
    ].join('\n'),
  );
});

test('uses the configured currency and keeps fractional totals to two decimals', () => {
  const text = receiptText({ ...order, total: 1250.5 }, 'USD');
  assert.ok(text.includes('Total: USD 1250.50'), text);
});

test('leaves a whole total undecorated', () => {
  assert.ok(receiptText({ ...order, total: 0 }).includes('Total: NPR 0'));
});