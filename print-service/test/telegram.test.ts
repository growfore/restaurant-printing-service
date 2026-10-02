import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Order } from '../src/order.js';
import { createTelegramNotifier } from '../src/telegram.js';

const order: Order = {
  restaurantId: 'restaurant-1',
  orderId: '1042',
  items: [{ name: 'Chicken Momo', quantity: 2 }, { name: 'Coke', quantity: 1 }],
  total: 650,
};

test('sends the receipt to the configured chat', async () => {
  const send = await captureFetch(async () => new Response('{"ok":true}', { status: 200 }));
  try {
    send.createTelegramNotifier({ botToken: 'bot-token', chatId: '42' })(order, 'sent');

    assert.equal(send.requests.length, 1);
    const [input, init] = send.requests[0] ?? [];
    assert.equal(input, 'https://api.telegram.org/botbot-token/sendMessage');
    assert.equal(init?.method, 'POST');

    const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
    assert.equal(body.chat_id, '42');
    assert.ok(body.text.includes('Order #1042'), body.text);
    assert.ok(body.text.includes('2 × Chicken Momo'), body.text);
    assert.ok(body.text.includes('Total: NPR 650'), body.text);
    assert.ok(body.text.includes('✅ Sent to printer'), body.text);
  } finally {
    await send.restore();
  }
});

test('warns loudly when no printer was connected', async () => {
  const send = await captureFetch(async () => new Response('{"ok":true}', { status: 200 }));
  try {
    send.createTelegramNotifier({ botToken: 'bot-token', chatId: '42' })(order, 'no_printer');

    const body = JSON.parse(String(send.requests[0]?.[1]?.body)) as { text: string };
    assert.ok(body.text.includes('⚠️ NOT printed — no print agent connected'), body.text);
    assert.ok(!body.text.includes('✅'), 'must not claim the order was printed');
  } finally {
    await send.restore();
  }
});

test('never throws when telegram is unreachable, and says so', async () => {
  const send = await captureFetch(async () => {
    throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
  });
  try {
    assert.doesNotThrow(() => send.createTelegramNotifier({ botToken: 't', chatId: '42' })(order, 'sent'));
    await send.settled();
    assert.match(send.logs.join('\n'), /telegram notification failed.*ENOTFOUND/);
  } finally {
    await send.restore();
  }
});

test('never throws when telegram rejects the message', async () => {
  const send = await captureFetch(async () => new Response('{"ok":false}', { status: 401 }));
  try {
    assert.doesNotThrow(() => send.createTelegramNotifier({ botToken: 't', chatId: '42' })(order, 'sent'));
    await send.settled();
    assert.match(send.logs.join('\n'), /telegram rejected the message.*HTTP 401/);
  } finally {
    await send.restore();
  }
});

test('does not await the send, so the order response is never delayed', async () => {
  const send = await captureFetch(() => new Promise<Response>(() => {}));
  try {
    // A request that never settles: the notifier must still return immediately.
    const returned = send.createTelegramNotifier({ botToken: 't', chatId: '42' })(order, 'sent');
    assert.equal(returned, undefined);
  } finally {
    await send.restore();
  }
});

/** Replaces global fetch, then hands back a notifier factory wired to the captured calls. */
async function captureFetch(respond: () => Promise<Response>) {
  const requests: Array<[string, RequestInit | undefined]> = [];
  const logs: string[] = [];
  const original = globalThis.fetch;
  let pending = 0;

  globalThis.fetch = ((input: string, init?: RequestInit) => {
    requests.push([input, init]);
    pending += 1;
    return respond().finally(() => {
      pending -= 1;
    });
  }) as typeof fetch;

  return {
    requests,
    logs,
    createTelegramNotifier: (options: { botToken: string; chatId: string; currency?: string }) =>
      createTelegramNotifier({ ...options, log: (message) => logs.push(message) }),
    /** Waits for the fire-and-forget fetch chain to finish. */
    settled: async () => {
      for (let attempt = 0; attempt < 100 && pending > 0; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    restore: async () => {
      globalThis.fetch = original;
    },
  };
}