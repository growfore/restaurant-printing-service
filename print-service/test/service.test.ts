import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, afterEach, before, test } from 'node:test';
import WebSocket from 'ws';
import { createPrintService, type PrintService } from '../src/index.js';
import type { NotifyStatus } from '../src/telegram.js';

const AGENT_TOKEN = 'test-token';

const order = {
  restaurantId: 'restaurant-1',
  orderId: '1042',
  items: [{ name: 'Chicken Momo', quantity: 2 }, { name: 'Coke', quantity: 1 }],
  total: 650,
};

type Frame = Record<string, unknown>;

let service: PrintService;
let baseUrl: string;
let agentUrl: string;
const agents: FakeAgent[] = [];

before(async () => {
  service = createPrintService({ agentToken: AGENT_TOKEN, heartbeatMs: 100, serveWebsite: true });
  const port = await service.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${port}`;
  agentUrl = `ws://127.0.0.1:${port}/agent`;
});

after(async () => {
  await service.close();
});

afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

test('an order for a restaurant with no agent is rejected as offline', async () => {
  const response = await postOrder(order);
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'AGENT_OFFLINE');
  assert.match(String(response.body.message), /no print agent connected for restaurant "restaurant-1"/);
});

test('an agent with a valid token is registered', async () => {
  const agent = await connectAgent();
  await agent.waitFor('registered');
  assert.equal(agent.frames.at(0)?.type, 'registered');
  assert.equal(agent.frames.at(0)?.restaurantId, 'restaurant-1');

  const listed = await getAgents();
  assert.equal(listed.count, 1);
  assert.equal(listed.agents[0]?.restaurantId, 'restaurant-1');
});

test('an agent with a bad token is rejected and never receives orders', async () => {
  const agent = await connectAgent({ token: 'wrong-token' });
  await agent.waitFor('register_error');
  assert.equal(agent.frames.at(0)?.error, 'INVALID_CREDENTIALS');
  await agent.waitForClose();

  assert.equal((await getAgents()).count, 0);
  assert.equal((await postOrder(order)).status, 503);
});

test('an agent with an empty restaurant id is rejected', async () => {
  const agent = await connectAgent({ restaurantId: '  ' });
  await agent.waitFor('register_error');
  assert.equal((await getAgents()).count, 0);
});

test('a registered order is delivered to the agent over the websocket', async () => {
  const agent = await connectAgent();
  await agent.waitFor('registered');

  const response = await postOrder(order);
  assert.equal(response.status, 202);
  assert.equal(response.body.orderId, '1042');
  assert.equal(response.body.status, 'sent_to_agent');

  const frame = await agent.waitFor('new_order');
  assert.deepEqual(frame.order, order);
});

test('the print acknowledgement is recorded against the agent', async () => {
  const agent = await connectAgent();
  await agent.waitFor('registered');
  await postOrder(order);
  await agent.waitFor('new_order');

  agent.send({ type: 'print_result', orderId: '1042', ok: true });
  await eventually(async () => (await getAgents()).agents[0]?.lastPrint?.ok === true);

  const listed = await getAgents();
  assert.equal(listed.agents[0]?.lastPrint?.orderId, '1042');
  assert.equal(listed.agents[0]?.lastPrint?.error, undefined);
});

test('a failed print is recorded with its error', async () => {
  const agent = await connectAgent();
  await agent.waitFor('registered');
  agent.send({ type: 'print_result', orderId: '1043', ok: false, error: 'printer offline' });

  await eventually(async () => (await getAgents()).agents[0]?.lastPrint?.ok === false);
  assert.equal((await getAgents()).agents[0]?.lastPrint?.error, 'printer offline');
});

test('orders only reach the agent for the matching restaurant', async () => {
  const other = await connectAgent({ restaurantId: 'restaurant-2' });
  await other.waitFor('registered');

  const mine = await connectAgent();
  await mine.waitFor('registered');

  await postOrder(order);
  await mine.waitFor('new_order');
  assert.equal(other.frames.some((frame) => frame.type === 'new_order'), false);
});

test('a disconnected agent is dropped from the registry and orders fail again', async () => {
  const agent = await connectAgent();
  await agent.waitFor('registered');
  agent.close();
  await eventually(async () => (await getAgents()).count === 0);

  const response = await postOrder(order);
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'AGENT_OFFLINE');
});

test('an agent that reconnects picks up orders again', async () => {
  const first = await connectAgent();
  await first.waitFor('registered');
  first.close();
  await eventually(async () => (await getAgents()).count === 0);

  const second = await connectAgent();
  await second.waitFor('registered');
  assert.equal((await postOrder(order)).status, 202);
  await second.waitFor('new_order');
});

test('a second agent for the same restaurant replaces the first', async () => {
  const first = await connectAgent();
  await first.waitFor('registered');

  const second = await connectAgent();
  await second.waitFor('registered');
  await first.waitFor('replaced');

  await postOrder(order);
  await second.waitFor('new_order');
  assert.equal(first.frames.some((frame) => frame.type === 'new_order'), false);
});

test('an agent that stops answering pings is dropped so orders are not swallowed', async () => {
  const agent = await connectAgent();
  await agent.waitFor('registered');
  assert.equal((await postOrder(order)).status, 202);

  // Stop replying to pings, the way a sleeping laptop does.
  agent.socket.pong = () => {};
  await eventually(async () => (await getAgents()).count === 0, 3000);
  assert.equal((await postOrder(order)).status, 503);
});

test('a bad order payload is rejected before any delivery', async () => {
  const agent = await connectAgent();
  await agent.waitFor('registered');

  for (const [payload, expectedError] of [
    [{ ...order, items: [] }, 'INVALID_ORDER'],
    [{ ...order, total: -5 }, 'INVALID_ORDER'],
    [{ ...order, restaurantId: undefined }, 'INVALID_ORDER'],
    ['not json at all', 'INVALID_JSON'],
  ] as const) {
    const response = await postOrder(payload);
    assert.equal(response.status, 400, `for ${JSON.stringify(payload)}`);
    assert.equal(response.body.error, expectedError);
  }
  assert.equal(agent.frames.some((frame) => frame.type === 'new_order'), false);
});

test('an oversized body is refused', async () => {
  const response = await postOrder({ ...order, items: [{ name: 'C'.repeat(70_000), quantity: 1 }] });
  assert.equal(response.status, 413);
});

test('an unknown route returns 404', async () => {
  assert.equal((await fetch(`${baseUrl}/nope`)).status, 404);
});

test('the test website is served at the root when enabled', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);

  const html = await response.text();
  assert.ok(html.includes('Chicken Momo'), 'the sample menu should be on the page');
  assert.ok(html.includes('/orders'), 'the page should post orders to the service');
  assert.equal((await fetch(`${baseUrl}/index.html`)).status, 200);
});

test('the test website is not served by default, so a public deploy cannot expose it', async () => {
  const plain = createPrintService({ agentToken: AGENT_TOKEN });
  const port = await plain.listen(0, '127.0.0.1');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`)).status, 404);
    // The real endpoints stay reachable.
    assert.equal((await fetch(`http://127.0.0.1:${port}/agents`)).status, 200);
  } finally {
    await plain.close();
  }
});

test('an agent upgrade is refused on any path except /agent', async () => {
  for (const url of [`ws://127.0.0.1:${new URL(baseUrl).port}`, `ws://127.0.0.1:${new URL(baseUrl).port}/orders`]) {
    const error = await new Promise<Error>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error(`${url} neither connected nor refused`)), 2_000);
      socket.on('open', () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error(`${url} should not be accepted`));
      });
      socket.on('error', (failure: Error) => {
        clearTimeout(timer);
        resolve(failure);
      });
    });
    assert.match(error.message, /400/, `expected a 400 refusal from ${url}, got: ${error.message}`);
  }
});

test('the service token guards the agent list as well as the order endpoint', async () => {
  const secured = createPrintService({ agentToken: AGENT_TOKEN, serviceToken: 'service-secret' });
  const port = await secured.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${port}/agents`;

  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer nope' } })).status, 401);

    const allowed = await fetch(url, { headers: { authorization: 'Bearer service-secret' } });
    assert.equal(allowed.status, 200);
    const listed = (await allowed.json()) as { count: number };
    assert.equal(listed.count, 0);
  } finally {
    await secured.close();
  }
});

test('the service token is enforced when configured', async () => {
  const secured = createPrintService({ agentToken: AGENT_TOKEN, serviceToken: 'service-secret' });
  const port = await secured.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${port}/orders`;
  const body = JSON.stringify(order);

  try {
    const rejected = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(rejected.status, 401);

    const agent = await connectAgent({ url: `ws://127.0.0.1:${port}/agent` });
    await agent.waitFor('registered');

    const wrong = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body,
    });
    assert.equal(wrong.status, 401);

    const allowed = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer service-secret' },
      body,
    });
    assert.equal(allowed.status, 202);
  } finally {
    await secured.close();
  }
});

// --- notifications -------------------------------------------------------

test('a delivered order is announced as sent to the printer', async () => {
  const spy = await startNotifyingService();
  try {
    const agent = await connectAgent({ url: `${spy.wsUrl}` });
    await agent.waitFor('registered');

    assert.equal((await postOrder(order, spy.url)).status, 202);
    assert.deepEqual(spy.calls, [{ orderId: '1042', status: 'sent' }]);
  } finally {
    await spy.service.close();
  }
});

test('an order for an offline restaurant is announced as NOT printed', async () => {
  const spy = await startNotifyingService();
  try {
    const response = await postOrder(order, spy.url);
    assert.equal(response.status, 503);
    assert.deepEqual(spy.calls, [{ orderId: '1042', status: 'no_printer' }]);
  } finally {
    await spy.service.close();
  }
});

test('an invalid payload is rejected and never announced, so it cannot be used to spam', async () => {
  const spy = await startNotifyingService();
  try {
    for (const payload of [{ ...order, items: [] }, { ...order, total: -5 }, { ...order, restaurantId: undefined }, 'not json']) {
      assert.equal((await postOrder(payload, spy.url)).status, 400);
    }
    assert.deepEqual(spy.calls, []);
  } finally {
    await spy.service.close();
  }
});

test('a notifier that throws cannot fail the order', async () => {
  const service = createPrintService({
    agentToken: AGENT_TOKEN,
    notify: () => {
      throw new Error('telegram is down');
    },
  });
  const port = await service.listen(0, '127.0.0.1');
  try {
    const agent = await connectAgent({ url: `ws://127.0.0.1:${port}/agent` });
    await agent.waitFor('registered');
    assert.equal((await postOrder(order, `http://127.0.0.1:${port}/orders`)).status, 202);
  } finally {
    await service.close();
  }
});

async function startNotifyingService() {
  const calls: Array<{ orderId: string; status: NotifyStatus }> = [];
  const service = createPrintService({
    agentToken: AGENT_TOKEN,
    notify: (announced, status) => calls.push({ orderId: announced.orderId, status }),
  });
  const port = await service.listen(0, '127.0.0.1');
  return { service, calls, url: `http://127.0.0.1:${port}/orders`, wsUrl: `ws://127.0.0.1:${port}/agent` };
}

// --- helpers -------------------------------------------------------------

function connectAgent(options: { restaurantId?: string; token?: string; url?: string } = {}): Promise<FakeAgent> {
  const agent = new FakeAgent();
  agents.push(agent);
  return agent.connect(options);
}

class FakeAgent {
  socket!: WebSocket;
  frames: Frame[] = [];
  private waiters: Array<{ type: string; resolve: (frame: Frame) => void }> = [];

  async connect(options: { restaurantId?: string; token?: string; url?: string }): Promise<this> {
    this.socket = new WebSocket(options.url ?? agentUrl);
    await once(this.socket, 'open');
    this.socket.on('message', (raw) => this.receive(JSON.parse(raw.toString()) as Frame));
    this.send({ type: 'register', restaurantId: options.restaurantId ?? 'restaurant-1', token: options.token ?? AGENT_TOKEN });
    return this;
  }

  send(frame: Frame) {
    this.socket.send(JSON.stringify(frame));
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
    }
  }

  waitFor(type: string, timeoutMs = 2000): Promise<Frame> {
    const already = this.frames.find((frame) => frame.type === type);
    if (already) return Promise.resolve(already);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`agent never received "${type}"`)), timeoutMs);
      this.waiters.push({ type, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
    });
  }

  waitForClose(timeoutMs = 2000): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agent socket never closed')), timeoutMs);
      this.socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  private receive(frame: Frame) {
    this.frames.push(frame);
    const index = this.waiters.findIndex((waiter) => waiter.type === frame.type);
    if (index >= 0) this.waiters.splice(index, 1)[0]?.resolve(frame);
  }
}

async function postOrder(payload: unknown, url = `${baseUrl}/orders`) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getAgents() {
  const response = await fetch(`${baseUrl}/agents`);
  return (await response.json()) as {
    count: number;
    agents: Array<{ restaurantId: string; lastPrint?: { orderId: string; ok: boolean; error?: string } | null }>;
  };
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition never became true');
}
