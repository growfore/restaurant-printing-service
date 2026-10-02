export type OrderItem = {
  name: string;
  quantity: number;
};

export type Order = {
  restaurantId: string;
  orderId: string;
  items: OrderItem[];
  total: number;
};

export interface Printer {
  print(order: Order): Promise<void>;
  testPrint(): Promise<void>;
}

const WIDTH = 30;
const SEPARATOR = '='.repeat(WIDTH);
const TITLE = 'NEW ORDER';

/** Both printers print this exact text, so the mock is a faithful stand-in for the hardware. */
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

export function testReceiptText(currency = 'NPR'): string {
  const heading = ' '.repeat(Math.floor((WIDTH - 'PRINTER TEST'.length) / 2)) + 'PRINTER TEST';
  return [
    SEPARATOR,
    heading,
    SEPARATOR,
    'If you can read this, the printer works.',
    `Currency: ${currency}`,
    SEPARATOR,
  ].join('\n');
}

function formatAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}
