import { createRequire } from 'node:module';
import { receiptText, testReceiptText, type Order, type Printer } from './printer.js';

export type EscPosPrinterOptions = {
  host: string;
  port?: number;
  encoding?: string;
  currency?: string;
};

/**
 * Prints over the network to a thermal printer's raw port (9100 by default).
 * Everything protocol-specific stays in this file; the rest of the agent only sees Printer.
 */
export class EscPosPrinter implements Printer {
  private readonly host: string;
  private readonly port: number;
  private readonly encoding: string | undefined;
  private readonly currency: string;

  constructor(options: EscPosPrinterOptions) {
    this.host = options.host;
    this.port = options.port ?? 9100;
    this.encoding = options.encoding;
    this.currency = options.currency ?? 'NPR';
  }

  async print(order: Order): Promise<void> {
    await this.write(receiptText(order, this.currency));
  }

  async testPrint(): Promise<void> {
    await this.write(testReceiptText(this.currency));
  }

  // ponytail: opens the socket per receipt instead of holding it open. Costs a few ms of TCP
  // setup per order, buys self-healing after a printer reboot or a dropped link. Hold a
  // persistent connection (and reconnect on error) if per-order latency ever matters.
  private async write(text: string): Promise<void> {
    // Loaded lazily so mock mode never pays for the escpos dependency.
    const { Printer, Network } = loadEscPos();
    const device = new Network(this.host, this.port);
    const printer = new Printer(device, this.encoding ? { encoding: this.encoding } : undefined);

    await new Promise<void>((resolve, reject) => {
      device.open((error) => (error ? reject(error) : resolve()));
    });
    try {
      printer.text(text).cut();
      await new Promise<void>((resolve, reject) => {
        printer.flush((error) => (error ? reject(error) : resolve()));
      });
    } finally {
      await new Promise<void>((resolve) => printer.close(() => resolve()));
    }
  }
}

type EscPos = typeof import('escpos');

function loadEscPos(): EscPos {
  const require = createRequire(import.meta.url);
  const escpos = require('escpos') as EscPos;
  // The escpos package expects adapters to be attached by the caller.
  return Object.assign(escpos, { Network: require('escpos-network') });
}
