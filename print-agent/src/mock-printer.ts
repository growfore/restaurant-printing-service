import { receiptText, testReceiptText, type Order, type Printer } from './printer.js';

export type MockPrinterOptions = {
  currency?: string;
  /** Swapped out in tests to capture the receipt instead of writing it to the terminal. */
  out?: (line: string) => void;
};

/** The default printer: writes receipts to stdout so the whole flow is testable without hardware. */
export class MockPrinter implements Printer {
  private readonly currency: string;
  private readonly out: (line: string) => void;

  constructor(options: MockPrinterOptions = {}) {
    this.currency = options.currency ?? 'NPR';
    this.out = options.out ?? ((line) => console.log(line));
  }

  async print(order: Order): Promise<void> {
    this.out(receiptText(order, this.currency));
  }

  async testPrint(): Promise<void> {
    this.out(testReceiptText(this.currency));
  }
}
