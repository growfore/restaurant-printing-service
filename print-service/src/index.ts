import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { validateOrder, type Order } from './order.js';
import { createTelegramNotifier, type Notifier, type NotifyStatus } from './telegram.js';

const MAX_BODY_BYTES = 64 * 1024;
const REGISTRATION_TIMEOUT_MS = 10_000;
/** The only path the WebSocket server answers on. An upgrade anywhere else gets a 400. */
const AGENT_PATH = '/agent';
const DEFAULT_PORT = 1234;
/** The test ordering page. This file lives in print-service/src, so it is two levels up. */
const WEBSITE_PAGE = new URL('../../website/index.html', import.meta.url);

export type PrintServiceOptions = {
  /** Shared secret every agent must present. Required: an empty token would let anyone register. */
  agentToken: string;
  /** Optional bearer token for POST /orders and GET /agents. Leave undefined to disable (local dev). */
  serviceToken?: string;
  /** How often to ping agents so dead ones are dropped from the registry. */
  heartbeatMs?: number;
  /** Serve the throwaway ordering page at GET /. Off by default so a public deploy cannot expose it. */
  serveWebsite?: boolean;
  /** Announce every accepted order. Omit to disable notifications. */
  notify?: Notifier;
};

type LastPrint = {
  orderId: string;
  ok: boolean;
  error?: string;
  at: string;
};

type Agent = {
  restaurantId: string;
  socket: WebSocket;
  connectedAt: number;
  isAlive: boolean;
  lastPrint?: LastPrint;
};

export type PrintService = {
  /** Resolves with the port that was actually bound (useful with port 0 in tests). */
  listen(port: number, host?: string): Promise<number>;
  agents: Map<string, Agent>;
  close(): Promise<void>;
};

export function createPrintService(options: PrintServiceOptions): PrintService {
  if (!options.agentToken) {
    throw new Error('agentToken is required');
  }
  const { agentToken, serviceToken, heartbeatMs = 30_000, serveWebsite = false, notify } = options;
  const agents = new Map<string, Agent>();

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'POST' && path === '/orders') {
      void handlePostOrder(req, res);
      return;
    }
    if (req.method === 'GET' && path === '/agents') {
      if (!authorised(req)) {
        sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Missing or invalid service token' });
        return;
      }
      sendJson(res, 200, { count: agents.size, agents: describeAgents() });
      return;
    }
    if (serveWebsite && req.method === 'GET' && (path === '/' || path === '/index.html')) {
      // Same-origin, so the page needs no CORS headers. Delete this route and ../website
      // together once the real website exists.
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(readFileSync(WEBSITE_PAGE));
      } catch {
        sendJson(res, 500, { error: 'WEBSITE_UNAVAILABLE', message: 'website/index.html could not be read' });
      }
      return;
    }
    sendJson(res, 404, {
      error: 'NOT_FOUND',
      message: serveWebsite
        ? 'Use GET / for the test website, POST /orders or GET /agents'
        : 'Use POST /orders or GET /agents',
    });
  });

  // Only AGENT_PATH upgrades are accepted; ws answers anything else with a 400. Keeping the
  // public surface here, in code, means it holds even if the reverse proxy is misconfigured.
  const wss = new WebSocketServer({ server, path: AGENT_PATH });

  // ws forwards the http server's errors to itself, so without a listener here a taken port
  // kills the process with an unhandled 'error' event instead of the clean startup failure
  // listen() reports. Port already in use is the most likely way this service fails to boot.
  wss.on('error', (error: Error) => log(`websocket server error: ${error.message}`));

  wss.on('connection', (socket: WebSocket) => {
    let registered: Agent | undefined;

    const registrationTimer = setTimeout(() => {
      if (!registered) socket.close(4002, 'registration timeout');
    }, REGISTRATION_TIMEOUT_MS);
    registrationTimer.unref();

    socket.on('pong', () => {
      if (registered) registered.isAlive = true;
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(registrationTimer);
      if (registered && agents.get(registered.restaurantId)?.socket === socket) {
        agents.delete(registered.restaurantId);
        log(`agent disconnected: ${registered.restaurantId} (${agents.size} online)`);
      }
    });

    socket.on('message', (raw: RawData) => {
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (typeof parsed !== 'object' || parsed === null) return;
        frame = parsed as Record<string, unknown>;
      } catch {
        return;
      }

      if (frame.type === 'register') {
        registered = register(socket, frame);
        return;
      }
      if (frame.type === 'print_result' && registered) {
        recordPrintResult(registered, frame);
      }
    });
  });

  function register(socket: WebSocket, frame: Record<string, unknown>): Agent | undefined {
    const restaurantId = typeof frame.restaurantId === 'string' ? frame.restaurantId.trim() : '';
    if (restaurantId === '' || frame.token !== agentToken) {
      send(socket, { type: 'register_error', error: 'INVALID_CREDENTIALS' });
      socket.close(4003, 'invalid credentials');
      log('rejected agent: invalid credentials');
      return undefined;
    }

    const previous = agents.get(restaurantId);
    if (previous && previous.socket !== socket) {
      // A newer process for the same restaurant is already here. Never print two copies.
      send(previous.socket, { type: 'replaced', message: 'replaced by a newer connection' });
      previous.socket.close(4000, 'replaced by a newer connection');
    }

    const agent: Agent = { restaurantId, socket, connectedAt: Date.now(), isAlive: true };
    agents.set(restaurantId, agent);
    send(socket, { type: 'registered', restaurantId });
    log(`agent connected: ${restaurantId} (${agents.size} online)`);
    return agent;
  }

  function recordPrintResult(agent: Agent, frame: Record<string, unknown>) {
    const orderId = typeof frame.orderId === 'string' ? frame.orderId : '';
    if (orderId === '') return;
    const ok = frame.ok === true;
    const error = typeof frame.error === 'string' ? frame.error.slice(0, 200) : undefined;
    agent.lastPrint = { orderId, ok, error, at: new Date().toISOString() };
    log(`agent ${agent.restaurantId} ${ok ? 'printed' : 'FAILED'} order ${orderId}${error ? ` — ${error}` : ''}`);
  }

  function deliver(restaurantId: string, order: Order): { ok: true } | { ok: false; message: string } {
    const agent = agents.get(restaurantId);
    if (!agent || agent.socket.readyState !== WebSocket.OPEN) {
      if (agent) agents.delete(restaurantId);
      return { ok: false, message: `no print agent connected for restaurant "${restaurantId}"` };
    }
    try {
      agent.socket.send(JSON.stringify({ type: 'new_order', order }));
    } catch {
      agents.delete(restaurantId);
      return { ok: false, message: 'the print agent connection broke while sending the order' };
    }
    return { ok: true };
  }

  /** No token configured means the check is skipped, which is the local dev default. */
  function authorised(req: IncomingMessage): boolean {
    return !serviceToken || isAuthorised(req, serviceToken);
  }

  async function handlePostOrder(req: IncomingMessage, res: ServerResponse) {
    if (!authorised(req)) {
      sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Missing or invalid service token' });
      return;
    }

    const body = await readBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: 'BAD_REQUEST', message: body.message });
      if (body.status === 413) req.destroy();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.raw);
    } catch {
      sendJson(res, 400, { error: 'INVALID_JSON', message: 'body must be valid JSON' });
      return;
    }

    const result = validateOrder(parsed);
    if (!result.ok) {
      // Not an order, so not announced: an invalid payload would be trivial to spam.
      sendJson(res, 400, { error: 'INVALID_ORDER', message: 'order payload is invalid', errors: result.errors });
      return;
    }

    const { order } = result;
    const delivery = deliver(order.restaurantId, order);
    if (!delivery.ok) {
      sendJson(res, 503, { error: 'AGENT_OFFLINE', message: delivery.message, orderId: order.orderId });
      announce(order, 'no_printer');
      return;
    }
    sendJson(res, 202, { ok: true, orderId: order.orderId, restaurantId: order.restaurantId, status: 'sent_to_agent' });
    announce(order, 'sent');
  }

  function announce(order: Order, status: NotifyStatus): void {
    if (!notify) return;
    try {
      notify(order, status);
    } catch (error) {
      // An injected notifier is third-party code; it must never be able to fail an order.
      log(`notification failed for order ${order.orderId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function describeAgents() {
    return [...agents.values()].map((agent) => ({
      restaurantId: agent.restaurantId,
      connectedAt: new Date(agent.connectedAt).toISOString(),
      lastPrint: agent.lastPrint ?? null,
    }));
  }

  // A sleeping laptop keeps its TCP socket half-open, so a dead agent would otherwise sit in
  // the registry looking healthy and swallow orders. Ping, then drop whoever misses a round.
  const heartbeat = setInterval(() => {
    for (const [restaurantId, agent] of agents) {
      if (!agent.isAlive) {
        agent.socket.terminate();
        agents.delete(restaurantId);
        log(`agent dropped (unresponsive): ${restaurantId}`);
        continue;
      }
      agent.isAlive = false;
      agent.socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    agents,
    listen(port, host) {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      });
    },
    async close() {
      clearInterval(heartbeat);
      for (const agent of agents.values()) agent.socket.terminate();
      agents.clear();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function send(socket: WebSocket, frame: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function isAuthorised(req: IncomingMessage, token: string) {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const alt = typeof req.headers['x-service-token'] === 'string' ? req.headers['x-service-token'] : '';
  return bearer === token || alt === token;
}

function readBody(req: IncomingMessage): Promise<{ ok: true; raw: string } | { ok: false; status: number; message: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Answer first, then hang up: destroying the request up front resets the connection
        // before the client can read the 413.
        resolve({ ok: false, status: 413, message: `body must be at most ${MAX_BODY_BYTES} bytes` });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false, status: 400, message: 'could not read the request body' }));
  });
}

function log(message: string) {
  console.log(`[print-service] ${message}`);
}

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: environment variables only.
  }

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const agentToken = process.env.AGENT_TOKEN?.trim() || 'development-token';
  const serviceToken = process.env.SERVICE_TOKEN?.trim() || undefined;
  const serveWebsite = process.env.SERVE_TEST_WEBSITE === 'true';

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const notify = botToken && chatId
    ? createTelegramNotifier({ botToken, chatId, currency: process.env.CURRENCY?.trim() || 'NPR', log })
    : undefined;

  const service = createPrintService({ agentToken, serviceToken, serveWebsite, notify });
  const boundPort = await service.listen(port);

  if (agentToken === 'development-token') {
    console.warn('[print-service] using the default development AGENT_TOKEN — set your own before exposing this service');
  }
  if (!serviceToken) {
    console.warn('[print-service] SERVICE_TOKEN is not set — POST /orders is open to anyone who can reach this port');
  }
  if (!notify) {
    console.warn('[print-service] Telegram notifications off — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable');
  }
  console.log(`[print-service] listening on http://localhost:${boundPort}`);
  console.log(`[print-service] agents connect to   ws://localhost:${boundPort}${AGENT_PATH}`);
  console.log('[print-service] send an order with: npm run test:order');
  if (serveWebsite) {
    console.log(`[print-service] test ordering page:   http://localhost:${boundPort}/`);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void service.close().then(() => process.exit(0));
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('[print-service] failed to start:', error);
    process.exit(1);
  });
}
