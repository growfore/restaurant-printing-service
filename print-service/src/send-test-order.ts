const target = process.env.SERVICE_URL ?? 'http://localhost:1234/orders';

// The order from the spec, so `npm run test:order` is a predictable smoke test.
const testOrder = {
  restaurantId: process.env.RESTAURANT_ID ?? 'restaurant-1',
  orderId: 'TEST-1001',
  items: [
    { name: 'Chicken Momo', quantity: 2 },
    { name: 'Coke', quantity: 1 },
  ],
  total: 650,
};

const res = await post();
console.log(`${target} -> ${res.status}`);
console.log(res.body);
if (res.status !== 202) {
  console.error(res.status === 503 ? 'The print agent is offline. Start it with: npm run dev' : 'The order was rejected.');
  process.exit(1);
}

async function post(attempt = 1): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(testOrder),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    if (attempt >= 5) throw error;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return post(attempt + 1);
  }
}
