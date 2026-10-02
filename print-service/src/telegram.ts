import type { Order } from './order.js';
import { receiptText } from './receipt.js';

/** Whether an agent was connected when the order arrived. */
export type NotifyStatus = 'sent' | 'no_printer';

/** Called once per accepted order. Must never block or throw. */
export type Notifier = (order: Order, status: NotifyStatus) => void;

export type TelegramOptions = {
  botToken: string;
  chatId: string;
  currency?: string;
  log?: (message: string) => void;
};

/**
 * Sends every accepted order to a Telegram chat through the Bot API.
 *
 * Deliberately fire-and-forget: the website's response is never delayed by Telegram, and a
 * Telegram outage cannot affect printing. Failures are logged and dropped — an order that
 * could not be announced is still an order that gets printed.
 */
export function createTelegramNotifier(options: TelegramOptions): Notifier {
  const { botToken, chatId, currency = 'NPR', log = () => {} } = options;

  return (order, status) => {
    void fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message(order, status, currency) }),
    })
      .then((response) => {
        if (response.ok) log(`telegram notified about order ${order.orderId} (${status})`);
        else log(`telegram rejected the message for order ${order.orderId}: HTTP ${response.status}`);
      })
      .catch((error: unknown) => {
        log(`telegram notification failed for order ${order.orderId}: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
}

function message(order: Order, status: NotifyStatus, currency: string): string {
  const heading = status === 'sent' ? `🖨 New order — ${order.restaurantId}` : `⚠️ Order received — ${order.restaurantId}`;
  // At this point the service only knows an agent was connected, never that paper came out.
  // The print_result acknowledgement arrives later, so "sent to printer" is the honest wording.
  const footer = status === 'sent' ? '✅ Sent to printer' : '⚠️ NOT printed — no print agent connected';
  return [heading, '', receiptText(order, currency), '', footer].join('\n');
}