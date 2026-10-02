import { WebSocket, type RawData } from 'ws';
import { EscPosPrinter } from './escpos-printer.js';
import { MockPrinter } from './mock-printer.js';
import type { Order, Printer } from './printer.js';

const MAX_RETRY_MS = 10_000;
/** How many order ids to remember for duplicate protection. */
const DEFAULT_SEEN_LIMIT = 500;

export type AgentOptions = {
  url: string;
  restaurantId: string;
  token: string;
  printer: Printer;
  printerLabel: string;
  log?: (message: string) => void;
  seenLimit?: number;
};

export class PrintAgent {
  private readonly log: (message: string) => void;
  private readonly seen = new Set<string>();
  private readonly seenLimit: number;
  private socket: WebSocket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs = 1_000;
  private stopped = false;
  private status = '';

  constructor(private readonly options: AgentOptions) {
    this.log = options.log ?? ((message) => console.log(message));
    this.seenLimit = options.seenLimit ?? DEFAULT_SEEN_LIMIT;
  }

  start(): void {
    this.stopped = false;
    this.setStatus('Connecting');
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus('Stopped');
  }

  private open(): void {
    const { url, restaurantId, token } = this.options;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'register', restaurantId, token }));
    });
    socket.on('message', (raw: RawData) => {
      void this.onMessage(raw);
    });
    // A socket error is always followed by 'close', which owns the reconnect.
    socket.on('error', () => {});
    socket.on('close', (code) => {
      this.socket = null;
      this.setStatus('Disconnected');
      if (this.stopped) return;
      if (code === 4003) {
        this.log('credentials rejected by the print service — check RESTAURANT_ID and AGENT_TOKEN');
        this.stopped = true;
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, MAX_RETRY_MS);
    this.log(`reconnecting in ${Math.round(delay / 100) / 10}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
    // Deliberately not unref'd: this timer is the agent's main loop, and it is what keeps the
    // process alive while the print service is down. stop() clears it when we do want to exit.
  }

  private async onMessage(raw: RawData): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (typeof parsed !== 'object' || parsed === null) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (frame.type === 'registered') {
      this.retryDelayMs = 1_000;
      this.setStatus('Connected');
      this.log('waiting for orders');
      return;
    }
    if (frame.type === 'register_error') {
      this.log(`registration refused: ${String(frame.error)}`);
      return;
    }
    if (frame.type === 'replaced') {
      this.log('another agent took over this restaurant — shutting down so orders cannot print twice');
      this.stop();
      return;
    }
    if (frame.type === 'new_order') {
      await this.printOrder(frame.order as Order);
    }
  }

  private async printOrder(order: Order): Promise<void> {
    if (this.seen.has(order.orderId)) {
      this.log(`skipped order ${order.orderId} — already printed (duplicate)`);
      this.acknowledge(order.orderId, true, 'duplicate');
      return;
    }
    try {
      await this.options.printer.print(order);
      this.remember(order.orderId);
      this.log(`printed order ${order.orderId}`);
      this.acknowledge(order.orderId, true);
    } catch (error) {
      // Deliberately not remembered: a redelivered event should be allowed to print.
      const message = error instanceof Error ? error.message : String(error);
      this.log(`FAILED to print order ${order.orderId} — ${message}`);
      this.acknowledge(order.orderId, false, message);
    }
  }

  private acknowledge(orderId: string, ok: boolean, error?: string): void {
    this.socket?.send(JSON.stringify({ type: 'print_result', orderId, ok, error }));
  }

  private remember(orderId: string): void {
    this.seen.add(orderId);
    if (this.seen.size > this.seenLimit) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private setStatus(state: string): void {
    if (state === this.status) return;
    this.status = state;
    this.log(
      [
        '',
        'Print Agent',
        `Restaurant: ${this.options.restaurantId}`,
        `Status: ${state}`,
        `Printer: ${this.options.printerLabel}`,
      ].join('\n'),
    );
  }
}

function createPrinter(env: NodeJS.ProcessEnv): { printer: Printer; label: string } {
  const currency = env.CURRENCY?.trim() || 'NPR';
  const mode = (env.PRINTER_MODE ?? 'mock').trim().toLowerCase();

  if (mode === 'escpos') {
    const host = env.PRINTER_HOST?.trim();
    if (!host) throw new Error('PRINTER_HOST is required when PRINTER_MODE=escpos');
    const port = Number(env.PRINTER_PORT ?? 9100);
    return {
      printer: new EscPosPrinter({ host, port, currency, encoding: env.PRINTER_ENCODING?.trim() || undefined }),
      label: `ESC/POS ${host}:${port}`,
    };
  }
  if (mode !== 'mock') {
    throw new Error(`unknown PRINTER_MODE "${mode}" — use mock or escpos`);
  }
  return { printer: new MockPrinter({ currency }), label: 'Mock Printer' };
}

function main(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: environment variables only.
  }

  const { printer, label } = createPrinter(process.env);
  if (process.argv.includes('--test-print')) {
    printer
      .testPrint()
      .then(() => console.log('[print-agent] test print sent'))
      .catch((error: unknown) => {
        console.error('[print-agent] test print failed:', error);
        process.exit(1);
      });
    return;
  }

  const agent = new PrintAgent({
    url: process.env.PRINT_SERVICE_URL?.trim() || 'ws://localhost:1234/agent',
    restaurantId: process.env.RESTAURANT_ID?.trim() || 'restaurant-1',
    token: process.env.AGENT_TOKEN?.trim() || 'development-token',
    printer,
    printerLabel: label,
    log: (message) => console.log(message),
  });

  agent.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      agent.stop();
      process.exit(0);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error('[print-agent] failed to start:', error);
    process.exit(1);
  }
}
