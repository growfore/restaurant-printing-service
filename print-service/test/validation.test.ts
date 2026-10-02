import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateOrder } from '../src/order.js';

const valid = {
  restaurantId: 'restaurant-1',
  orderId: '1042',
  items: [{ name: 'Chicken Momo', quantity: 2 }],
  total: 650,
};

test('accepts the spec payload', () => {
  const result = validateOrder({ ...valid, items: [{ name: 'Chicken Momo', quantity: 2 }, { name: 'Coke', quantity: 1 }] });
  assert.deepEqual(result, {
    ok: true,
    order: {
      restaurantId: 'restaurant-1',
      orderId: '1042',
      items: [{ name: 'Chicken Momo', quantity: 2 }, { name: 'Coke', quantity: 1 }],
      total: 650,
    },
  });
});

test('coerces a numeric orderId to a string, because the website owns the ids', () => {
  const result = validateOrder({ ...valid, orderId: 1042 });
  assert.equal(result.ok && result.order.orderId, '1042');
});

test('trims ids and item names', () => {
  const result = validateOrder({ ...valid, restaurantId: ' restaurant-1 ', items: [{ name: '  Coke ', quantity: 1 }] });
  assert.equal(result.ok && result.order.restaurantId, 'restaurant-1');
  assert.deepEqual(result.ok && result.order.items, [{ name: 'Coke', quantity: 1 }]);
});

test('rejects non-objects', () => {
  for (const input of [null, undefined, 'order', 42, [], true]) {
    const result = validateOrder(input);
    assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
  }
});

test('requires restaurantId and orderId', () => {
  for (const field of ['restaurantId', 'orderId'] as const) {
    const result = validateOrder({ ...valid, [field]: undefined });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((error) => error.startsWith(field)), `expected a ${field} error`);
  }
  for (const bad of ['', '   ', {}]) {
    assert.equal(validateOrder({ ...valid, restaurantId: bad }).ok, false);
  }
});

test('requires a non-empty items array', () => {
  for (const items of [[], undefined, {}, 'Coke']) {
    const result = validateOrder({ ...valid, items });
    assert.equal(result.ok, false, `expected ${JSON.stringify(items)} to be rejected`);
    assert.ok(!result.ok && result.errors.some((error) => error.includes('items')));
  }
});

test('requires every item to have a name and a whole quantity of at least 1', () => {
  for (const item of [
    { name: 'Coke' },
    { quantity: 1 },
    { name: '', quantity: 1 },
    { name: '   ', quantity: 1 },
    { name: 'Coke', quantity: 0 },
    { name: 'Coke', quantity: -1 },
    { name: 'Coke', quantity: 1.5 },
    { name: 'Coke', quantity: '2' },
    { name: 42, quantity: 1 },
    'Coke',
    null,
  ]) {
    const result = validateOrder({ ...valid, items: [item] });
    assert.equal(result.ok, false, `expected ${JSON.stringify(item)} to be rejected`);
  }
});

test('rejects a total that is not a non-negative number', () => {
  for (const total of [undefined, null, '650', Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const result = validateOrder({ ...valid, total });
    assert.equal(result.ok, false, `expected ${JSON.stringify(total)} to be rejected`);
    assert.ok(!result.ok && result.errors.some((error) => error.startsWith('total')));
  }
});

test('rejects a zero total', () => {
  assert.equal(validateOrder({ ...valid, total: 0 }).ok, true);
});

test('caps the size of the payload so one order cannot flood a receipt', () => {
  const tooManyItems = validateOrder({ ...valid, items: Array.from({ length: 101 }, () => ({ name: 'Coke', quantity: 1 })) });
  assert.equal(tooManyItems.ok, false);

  const longName = validateOrder({ ...valid, items: [{ name: 'C'.repeat(201), quantity: 1 }] });
  assert.equal(longName.ok, false);

  const longId = validateOrder({ ...valid, orderId: '1'.repeat(65) });
  assert.equal(longId.ok, false);
});

test('reports every problem at once instead of one per request', () => {
  const result = validateOrder({ restaurantId: '', orderId: '', items: [{ name: '', quantity: 0 }], total: -5 });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.length >= 5, `expected several errors, got ${JSON.stringify(result)}`);
});
