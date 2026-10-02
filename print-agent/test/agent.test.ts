import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { test } from 'node:test';
import iconv from 'iconv-lite';
import { WebSocket, WebSocketServer } from 'ws';
import { PrintAgent } from '../src/index.js';
import { EscPosPrinter } from '../src/escpos-printer.js';
import { MockPrinter } from '../src/mock-printer.js';
import { receiptText, type Order, type Printer } from '../src/printer.js';

const order: Order = {
  restaurantId: 'restaurant-1',
  orderId: '1042',
  items: [{ name: 'Chicken Momo', quantity: 2 }, { name: 'Coke', quantity: 1 }],
  total: 650,
};

const secondOrder: Order = { ...order, orderId: '1043' };

// --- the printers -------------------------------------------------------

test('the mock printer prints the receipt from the spec', async () => {
  const lines: string[] = [];
  const printer = new MockPrinter({ out: (line) => lines.push(line) });

  await printer.print(order);

  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
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

test('the receipt uses the configured currency and formats fractional totals', async () => {
  const lines: string[] = [];
  const printer = new MockPrinter({ currency: 'USD', out: (line) => lines.push(line) });
  await printer.print({ ...order, total: 1250.5 });
  assert.ok(lines[0]?.includes('Total: USD 1250.50'), lines[0]);
});

test('the escpos printer writes a real receipt and a cut command to the printer port', async () => {
  const { printer, received, stop } = await captureEscPosOutput(
    (port) => new EscPosPrinter({ host: '127.0.0.1', port, encoding: 'GB18030' }),
  );

  try {
    await printer.print(order);
    const bytes = await received();
    assert.ok(bytes.length > 0);

    // Decoded with the printer's own encoding: that is what the hardware will render.
    const printed = iconv.decode(bytes, 'GB18030');
    assert.ok(printed.includes('Order #1042'), printed);
    assert.ok(printed.includes('2 × Chicken Momo'), printed);
    assert.ok(printed.includes('Total: NPR 650'), printed);

    // GS V 0 = full cut, otherwise the paper hangs out of the printer.
    assert.ok(bytes.includes(Buffer.from([0x1d, 0x56, 0x00])), 'expected a paper cut command');
  } finally {
    await stop();
  }
});

test('the escpos printer test print reaches the printer', async () => {
  const { printer, received, stop } = await captureEscPosOutput((port) => new EscPosPrinter({ host: '127.0.0.1', port }));
  try {
    await printer.testPrint();
    assert.ok(iconv.decode(await received(), 'GB18030').includes('PRINTER TEST'));
  } finally {
    await stop();
  }
});

test('the escpos printer reports an unreachable printer instead of hanging', async () => {
  // Port 1 is reserved and never listening.
  const printer = new EscPosPrinter({ host: '127.0.0.1', port: 1 });
  await assert.rejects(() => printer.print(order));
});

// --- the agent against a fake print service -----------------------------

test('the agent registers itself with its restaurant id and token', async () => {
  const service = await FakeService.start();
  const logs: string[] = [];
  const agent = newAgent(service.url, new FakePrinter(), logs);

  try {
    await waitFor(() => service.received.some((frame) => frame.type === 'register'));
    const register = service.received.find((frame) => frame.type === 'register');
    assert.equal(register?.restaurantId, 'restaurant-1');
    assert.equal(register?.token, 'test-token');
    assert.ok(logs.some((line) => line.includes('Status: Connected')), logs.join('\n'));
  } finally {
    agent.stop();
    await service.stop();
  }
});

test('the agent prints an incoming order and acknowledges it', async () => {
  const service = await FakeService.start();
  const printer = new FakePrinter();
  const logs: string[] = [];
  const agent = newAgent(service.url, printer, logs);

  try {
    await service.delivered();
    service.sendOrder(order);

    await waitFor(() => printer.printed.length === 1);
    assert.deepEqual(printer.printed[0], order);

    await waitFor(() => service.results().length === 1);
    assert.deepEqual(service.results()[0], { type: 'print_result', orderId: '1042', ok: true });
  } finally {
    agent.stop();
    await service.stop();
  }
});

test('the agent acknowledges a failed print and does not remember the order', async () => {
  const service = await FakeService.start();
  const printer = new FakePrinter();
  printer.failWith = new Error('printer offline');
  const logs: string[] = [];
  const agent = newAgent(service.url, printer, logs);

  try {
    await service.delivered();
    service.sendOrder(order);

    await waitFor(() => service.results().length === 1);
    assert.deepEqual(service.results()[0], { type: 'print_result', orderId: '1042', ok: false, error: 'printer offline' });

    // The order was never marked as printed, so a redelivery gets another chance.
    printer.failWith = undefined;
    service.sendOrder(order);
    await waitFor(() => printer.printed.length === 1);
  } finally {
    agent.stop();
    await service.stop();
  }
});

test('the agent does not print the same order twice', async () => {
  const service = await FakeService.start();
  const printer = new FakePrinter();
  const logs: string[] = [];
  const agent = newAgent(service.url, printer, logs);

  try {
    await service.delivered();
    service.sendOrder(order);
    await waitFor(() => printer.printed.length === 1);

    service.sendOrder(order);
    service.sendOrder({ ...order, orderId: '1043' });

    await waitFor(() => service.results().filter((result) => result.orderId === '1042').length === 2);
    assert.deepEqual(printer.printed.map((printed) => printed.orderId), ['1042', '1043']);
    assert.deepEqual(service.results()[1], { type: 'print_result', orderId: '1042', ok: true, error: 'duplicate' });
  } finally {
    agent.stop();
    await service.stop();
  }
});

test('the agent reconnects on its own after the connection drops', async () => {
  const service = await FakeService.start();
  const port = service.port;
  const printer = new FakePrinter();
  const logs: string[] = [];
  const agent = newAgent(service.url, printer, logs);

  try {
    await service.delivered();
    service.sendOrder(order);
    await waitFor(() => printer.printed.length === 1);

    await service.stop();
    await service.listen(port);
    await waitFor(() => service.received.filter((frame) => frame.type === 'register').length === 2, 8_000);

    service.sendOrder(secondOrder);
    await waitFor(() => printer.printed.length === 2);
    assert.equal(printer.printed[1]?.orderId, '1043');
  } finally {
    agent.stop();
    await service.stop();
  }
});

test('the agent gives up when the service rejects its credentials', async () => {
  const service = await FakeService.start({ acceptToken: 'a-different-token' });
  const logs: string[] = [];
  const agent = newAgent(service.url, new FakePrinter(), logs);

  try {
    await waitFor(() => logs.some((line) => line.includes('credentials rejected')));
    const before = service.received.length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(service.received.length, before, 'the agent should not keep retrying bad credentials');
  } finally {
    agent.stop();
    await service.stop();
  }
});

test('the agent shuts down when a newer agent takes over the restaurant', async () => {
  const service = await FakeService.start();
  const logs: string[] = [];
  const agent = newAgent(service.url, new FakePrinter(), logs);

  try {
    await service.delivered();
    service.broadcast({ type: 'replaced', message: 'replaced by a newer connection' });
    await waitFor(() => logs.some((line) => line.includes('Status: Stopped')));
  } finally {
    agent.stop();
    await service.stop();
  }
});

test('the agent ignores frames it does not understand', async () => {
  const service = await FakeService.start();
  const printer = new FakePrinter();
  const logs: string[] = [];
  const agent = newAgent(service.url, printer, logs);

  try {
    await service.delivered();
    service.sendOrder(order);
    await waitFor(() => printer.printed.length === 1);

    service.broadcast({ type: 'something_new' });
    service.broadcast({ not: 'a frame at all' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(printer.printed.length, 1);
  } finally {
    agent.stop();
    await service.stop();
  }
});

// --- helpers ------------------------------------------------------------

class FakePrinter implements Printer {
  printed: Order[] = [];
  failWith: Error | undefined;

  async print(printedOrder: Order): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.printed.push(printedOrder);
  }

  async testPrint(): Promise<void> {}
}

function newAgent(url: string, printer: Printer, logs: string[]): PrintAgent {
  const agent = new PrintAgent({
    url,
    restaurantId: 'restaurant-1',
    token: 'test-token',
    printer,
    printerLabel: 'Fake Printer',
    log: (message) => logs.push(message),
  });
  agent.start();
  return agent;
}

type Frame = Record<string, unknown>;

class FakeService {
  readonly received: Frame[] = [];
  sockets: WebSocket[] = [];
  port = 0;
  url = '';
  private wss: WebSocketServer | undefined;
  private readonly acceptToken: string | undefined;

  private constructor(acceptToken?: string) {
    this.acceptToken = acceptToken;
  }

  static async start(options: { acceptToken?: string; port?: number } = {}): Promise<FakeService> {
    const service = new FakeService(options.acceptToken);
    await service.listen(options.port ?? 0);
    return service;
  }

  async listen(port = 0): Promise<void> {
    this.sockets = [];
    const wss = new WebSocketServer({ port, host: '127.0.0.1' });
    this.wss = wss;
    await once(wss, 'listening');
    this.port = (wss.address() as AddressInfo).port;
    this.url = `ws://127.0.0.1:${this.port}`;

    wss.on('connection', (socket) => {
      this.sockets.push(socket);
      socket.on('error', () => {});
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as Frame;
        this.received.push(frame);
        if (frame.type === 'register' && this.acceptToken && frame.token !== this.acceptToken) {
          socket.send(JSON.stringify({ type: 'register_error', error: 'INVALID_CREDENTIALS' }));
          socket.close(4003, 'invalid credentials');
          return;
        }
        if (frame.type === 'register') {
          socket.send(JSON.stringify({ type: 'registered', restaurantId: frame.restaurantId }));
        }
      });
    });
  }

  async delivered(): Promise<void> {
    await waitFor(() => this.sockets.length > 0);
  }

  sendOrder(order: Order): void {
    this.broadcast({ type: 'new_order', order });
  }

  broadcast(frame: Frame): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    }
  }

  results(): Frame[] {
    return this.received.filter((frame) => frame.type === 'print_result');
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    const wss = this.wss;
    this.wss = undefined;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

/** A stand-in thermal printer: a TCP server that keeps the bytes it is sent. */
async function captureEscPosOutput(build: (port: number) => Printer) {
  const chunks: Buffer[] = [];
  let markClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (chunk) => chunks.push(chunk));
    // The printer opens a connection per receipt and closes it, so this is the last byte.
    socket.once('end', markClosed);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    printer: build((server.address() as AddressInfo).port),
    received: async (): Promise<Buffer> => {
      const timedOut = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('the printer never closed the connection')), 5_000);
      });
      await Promise.race([closed, timedOut]);
      return Buffer.concat(chunks);
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition never became true');
}
