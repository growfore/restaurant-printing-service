import type { Order } from './order.js';

const WIDTH = 30;
const SEPARATOR = '='.repeat(WIDTH);
const TITLE = 'NEW ORDER';

/**
 * The same layout as print-agent/src/printer.ts receiptText().
 *
 * Duplicated on purpose: the service is deployed to a VPS without the agent folder, and a
 * cross-package import would couple them. Both test suites assert the identical expected
 * string, so the two copies cannot drift apart without a test failing.
 */
export function receiptText(order: Order, currency = 'NPR'): string {
  const heading = ' '.repeat(Math.floor((WIDTH - TITLE.length) / 2)) + TITLE;
  return [
    SEPARATOR,
    heading,
    SEPARATOR,
    `Order #${order.orderId}`,
    '',
    ...order.items.map((item) => `${item.quantity} × ${item.name}`),
    '',
    `Total: ${currency} ${formatAmount(order.total)}`,
    SEPARATOR,
  ].join('\n');
}

function formatAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}