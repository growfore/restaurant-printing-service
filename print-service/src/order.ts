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

export type ValidationResult =
  | { ok: true; order: Order }
  | { ok: false; errors: string[] };

const MAX_ITEMS = 100;
const MAX_NAME_LENGTH = 200;
const MAX_ID_LENGTH = 64;

/** The website is the source of truth, but never trust its payload. */
export function validateOrder(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const body = input as Record<string, unknown>;

  const restaurantId = readId(body.restaurantId, 'restaurantId', errors);
  const orderId = readId(body.orderId, 'orderId', errors);
  const items = readItems(body.items, errors);
  const total = readTotal(body.total, errors);

  if (errors.length > 0 || !restaurantId || !orderId || items === null) {
    return { ok: false, errors };
  }
  return { ok: true, order: { restaurantId, orderId, items, total } };
}

/** Accepts a string id, or a number id which is coerced (websites store ints). */
function readId(value: unknown, field: string, errors: string[]): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field} is required and must be a non-empty string`);
    return null;
  }
  const id = value.trim();
  if (id.length > MAX_ID_LENGTH) {
    errors.push(`${field} must be at most ${MAX_ID_LENGTH} characters`);
    return null;
  }
  return id;
}

function readItems(value: unknown, errors: string[]): OrderItem[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('items must be a non-empty array');
    return null;
  }
  if (value.length > MAX_ITEMS) {
    errors.push(`items must contain at most ${MAX_ITEMS} entries`);
    return null;
  }

  const items: OrderItem[] = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      errors.push(`items[${index}] must be an object`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const quantity = entry.quantity;

    if (name === '') {
      errors.push(`items[${index}].name is required`);
    } else if (name.length > MAX_NAME_LENGTH) {
      errors.push(`items[${index}].name must be at most ${MAX_NAME_LENGTH} characters`);
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      errors.push(`items[${index}].quantity must be an integer of at least 1`);
    }

    if (name !== '' && typeof quantity === 'number' && Number.isInteger(quantity) && quantity >= 1) {
      items.push({ name, quantity });
    }
  }
  return items;
}

function readTotal(value: unknown, errors: string[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push('total must be a number');
    return 0;
  }
  if (value < 0) {
    errors.push('total must not be negative');
    return 0;
  }
  return value;
}
