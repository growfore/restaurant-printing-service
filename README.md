# Restaurant Order Printing

A minimal order printing system: the restaurant website posts an order over HTTP, a tiny
service forwards it to the right agent over a WebSocket, and the agent prints it on a thermal
printer (or your terminal, during development).

```text
Restaurant Website
       |
       | HTTP POST /orders
       v
Print Service  (no database, in-memory agent registry)
       |
       | WebSocket
       v
Print Agent  (runs on the restaurant's computer)
       |
       | Printer interface
       v
MockPrinter (dev)  /  EscPosPrinter (real hardware)
```

Two small apps, each with its own `package.json`:

```text
restaurant-printing/
├── print-service/          HTTP + WebSocket server, holds the agent registry
│   ├── src/
│   │   ├── index.ts        server, agent registry, order routing, notifications
│   │   ├── order.ts        Order type + payload validation
│   │   ├── receipt.ts      receipt text for notifications
│   │   ├── telegram.ts     Telegram notifications
│   │   └── send-test-order.ts
│   ├── test/
│   ├── package.json
│   └── .env.example
│
├── print-agent/            long-running process on the restaurant's computer
│   ├── src/
│   │   ├── index.ts        connect, register, reconnect, dedupe, acknowledge
│   │   ├── printer.ts      Printer interface + shared receipt text
│   │   ├── mock-printer.ts prints receipts to stdout
│   │   └── escpos-printer.ts  real thermal printers
│   ├── test/
│   ├── package.json
│   └── .env.example
│
├── website/                throwaway test ordering page (not the real website)
│   └── index.html
│
└── README.md
```

The restaurant website and its database are the source of truth for orders. Neither app here
needs a database.

## 1. Install

Requires Node.js **20.12+** (developed on 22 LTS) — it uses `process.loadEnvFile()`. Install each app separately:

```bash
cd print-service
npm install

cd ../print-agent
npm install
```

Optionally copy the example config into `.env` in each app — the defaults already work
locally, so you can skip this until you change something:

```bash
cp print-service/.env.example print-service/.env
cp print-agent/.env.example   print-agent/.env
```

## 2. Start the print service

```bash
cd print-service
npm run dev
```

```text
[print-service] listening on http://localhost:1234
[print-service] agents connect to   ws://localhost:1234
[print-service] send an order with: npm run test:order
```

HTTP and WebSocket share port 1234. Agents must connect on `/agent`; an upgrade on any other
path is refused with a `400`. The service enforces its own public surface, so it holds even if
the reverse proxy is misconfigured.

The test ordering page is **off by default**. Turn it on for local development with
`SERVE_TEST_WEBSITE=true` — it is a working order form, so never enable it on a public host.

## 3. Start the agent

In a second terminal:

```bash
cd print-agent
npm run dev
```

```text
Print Agent
Restaurant: restaurant-1
Status: Connected
Printer: Mock Printer
```

That is the whole agent. It runs in the background, reconnects by itself if the service goes
away, and prints each order once.

## 4. Send a test order

With both running:

```bash
cd print-service
npm run test:order
```

```text
http://localhost:1234/orders -> 202
{
  "ok": true,
  "orderId": "TEST-1001",
  "restaurantId": "restaurant-1",
  "status": "sent_to_agent"
}
```

The agent terminal prints:

```text
==============================
          NEW ORDER
==============================
Order #TEST-1001

2 × Chicken Momo
1 × Coke

Total: NPR 650
==============================
```

From the website, the same thing with `curl`:

```bash
curl -X POST http://localhost:1234/orders \
  -H 'content-type: application/json' \
  -d '{"restaurantId":"restaurant-1","orderId":"1042","items":[{"name":"Chicken Momo","quantity":2},{"name":"Coke","quantity":1}],"total":650}'
```

### Responses

| Status | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `202`  | order handed to the connected agent                             |
| `400`  | invalid JSON or payload — the response lists every problem      |
| `413`  | request body over 64 KB                                         |
| `503`  | no agent connected for that `restaurantId` (nothing was printed) |
| `401`  | `SERVICE_TOKEN` is set and was missing or wrong                 |

### WebSocket protocol

Agent to service:

```jsonc
{ "type": "register", "restaurantId": "restaurant-1", "token": "development-token" }
{ "type": "print_result", "orderId": "1042", "ok": true, "error": "..." }
```

Service to agent:

```jsonc
{ "type": "registered", "restaurantId": "restaurant-1" }
{ "type": "new_order", "order": { "restaurantId": "restaurant-1", "orderId": "1042", "items": [...], "total": 650 } }
{ "type": "register_error", "error": "INVALID_CREDENTIALS" }
{ "type": "replaced", "message": "replaced by a newer connection" }
```

`GET /agents` shows who is connected and the last print result, which is the quickest way to
tell "the agent is offline" apart from "the printer is broken".

## 5. Try it in a browser

`website/index.html` is a small static ordering page with a sample menu. It is **off by default** —
set `SERVE_TEST_WEBSITE=true` in `print-service/.env` to enable it, then open:

```text
http://localhost:1234
```

Add items, watch the total, and press a button. Each one shows the exact HTTP status and JSON
body the service returned, so you can exercise every path without a terminal:

| Button | What it sends | What you should see |
| --- | --- | --- |
| **Place Order** | a valid order, `orderId: WEB-<timestamp>` | `202`, and a receipt on the agent terminal |
| **Resend last order** | the identical payload, same `orderId` | `202`, but the agent logs `skipped order … duplicate` |
| **Send invalid order** | `quantity: 0`, an empty item name, `total: -5` | `400` and the list of validation errors |
| **Refresh agents** | nothing — `GET /agents` | the agent registry and the last print result |

Set **Restaurant ID** to `restaurant-2` and press Place Order to see the `503 AGENT_OFFLINE`
response. The service token field is only needed if you configured `SERVICE_TOKEN`.

This page is a test harness, not the real website: no styles, no build step, no persistence.
The real website replaces it and posts to `POST /orders` exactly like this page does. When that
happens, delete `website/` and the `serveWebsite` branch in `print-service/src/index.ts` — the
page is served from the service purely so it is same-origin and needs no CORS.

## 6. Telegram notifications

The print service can announce every accepted order to a Telegram chat. Set both values in
`print-service/.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:AA...    # from @BotFather
TELEGRAM_CHAT_ID=987654321            # the chat that should receive orders
```

Leave either empty and notifications are off; the service says so at startup. No SDK is
involved — it is one `fetch` to `api.telegram.org/bot<token>/sendMessage`.

Each message is the full receipt, plus whether a printer was connected at the time:

```text
🖨 New order — restaurant-1

==============================
          NEW ORDER
==============================
Order #1042

2 × Chicken Momo
1 × Coke

Total: NPR 650
==============================

✅ Sent to printer
```

When no agent is connected the last line becomes
`⚠️ NOT printed — no print agent connected`. That is the alert worth having: the service sends
it whether or not anything could be printed, because "an order arrived and nothing came out" is
the failure you actually need to know about.

Deliberate behaviours:

- **Sent by the service, not the agent.** The service is always on and sees both "order
  arrived" and "no printer", so it can report the bad case. It also means notifications depend
  on the server's internet rather than the restaurant's connection — worth having, since
  Telegram is unreachable on some ISPs.
- **It says "sent to printer", not "printed".** At that moment the service only knows an agent
  was connected. Whether paper actually came out arrives later as the agent's acknowledgement,
  visible on `GET /agents`.
- **Fire-and-forget.** The website's response is never delayed by Telegram, and every failure —
  unreachable, rejected, rate-limited — is logged and dropped. An order that could not be
  announced is still an order that gets printed.
- **Invalid payloads are never announced**, so they cannot be used to spam the chat. A public
  `POST /orders` with no `SERVICE_TOKEN` can be spammed by anyone; set the token.

## 7. How mock printing works

`PRINTER_MODE=mock` (the default) prints the receipt to the agent's stdout instead of talking
to hardware. Nothing about the pipeline changes — the same `Printer` interface is used, and the
receipt text is produced by the same function for both printers, so the mock is a faithful
stand-in for the real thing. This is how the whole system is developed and tested without
owning a thermal printer.

## 8. Using a real ESC/POS printer

Copy `.env.example` to `.env` in `print-agent` and change:

```env
PRINTER_MODE=escpos
PRINTER_HOST=192.168.1.50   # printer IP on the same LAN
PRINTER_PORT=9100           # raw printing port, 9100 for almost all of them
PRINTER_ENCODING=GB18030    # character encoding of the printer
```

Then check the wiring before taking real orders:

```bash
npm run test:print
```

`EscPosPrinter` uses the [`escpos`](https://www.npmjs.com/package/escpos) package with the
network adapter — no protocol written by hand. The socket is opened per receipt and closed
after the paper cut, so the agent recovers on its own after a printer reboot or a dropped link.
Everything protocol-specific stays inside `src/escpos-printer.ts`; USB, serial or Bluetooth
would be a new adapter behind the same `Printer` interface.

Run it as a service on the restaurant's computer so it survives reboots — `pm2 start npm --name
print-agent -- run dev`, a systemd unit, or a Windows scheduled task all work. The agent is
state-free, so restarting it is safe.

## 9. Duplicate protection

An `orderId` must be unique, and the agent remembers the last 500 ids it printed. If the same
order arrives twice — for example the service redelivers it after a reconnect — the agent
skips the second copy and says so in the log:

```text
skipped order TEST-1001 — already printed (duplicate)
```

Failed prints are deliberately *not* remembered, so a redelivered order gets another chance.

**This is in-memory only. It is not durable.** Restarting the agent clears it, and the service
has no record of what was printed, so an order redelivered after an agent restart would print
twice. That is acceptable for the MVP. If it ever matters, the fix is a small local store of
printed `orderId`s on the agent (SQLite file) — not a database on the service.

Only one agent per restaurant prints: when a second agent connects with the same
`restaurantId`, the service closes the old connection with a `replaced` frame and the old
process shuts itself down. Two processes can never double-print the same order.

## 10. Security

- Every agent presents `restaurantId` + `AGENT_TOKEN`. The service rejects anything else with
  `INVALID_CREDENTIALS` and closes the socket.
- `AGENT_TOKEN` must be non-empty; the service refuses to start without it, and warns when the
  default `development-token` is still in use. Set a real one before exposing the service.
- Set `SERVICE_TOKEN` to require `Authorization: Bearer <token>` on `POST /orders`. Without it,
  anyone who can reach the port can trigger paper. Keep it off for local development.
- The agent connects outbound only, so it needs no inbound firewall rule.
- The service is plain HTTP and has no TLS — put it on localhost or a private network/VPN. Do
  not expose it to the internet as-is.

## Deploying

The print service runs on a public VPS; the agent runs on the restaurant's computer and dials
out. nginx terminates TLS in front of the service.

```text
website (server-side POST)              restaurant PC (behind a router)
        │  https://print.example.com/orders        │
        ▼ nginx :443 ── TLS                        │
        │ proxy_pass                                │
        ▼                                           │
   print-service 127.0.0.1:1234  (pm2, 1 instance)  │
        ▲                                           │
        │  wss://print.example.com/agent  ──────────┘
```

### VPS

```bash
node -v                                   # needs >= 20.12
git clone <repo> /var/www/print-service
cd /var/www/print-service/print-service
npm ci                                    # NOT --omit=dev: npm start runs through tsx
```

`.env` — real tokens, `chmod 600`:

```env
PORT=1234
AGENT_TOKEN=<random>          # shared with the agent
SERVICE_TOKEN=<different random>   # presented by the website as a bearer token
SERVE_TEST_WEBSITE=false
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
pm2 start npm --name print-service -i 1 -- start
pm2 startup && pm2 save
pm2 install pm2-logrotate
```

**`-i 1` is mandatory. Never use pm2 cluster mode.** The agent registry is an in-memory `Map`,
so a second worker would never see the agent registered on the first and every order would
return `503`. That would need a shared registry before it could be scaled.

### nginx

```nginx
# in the http {} block, once
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name print.example.com;

    location / {
        proxy_pass         http://127.0.0.1:1234;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host       $host;
        proxy_read_timeout 3600s;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/print-service /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d print.example.com
```

One block serves both, because a WebSocket starts as an ordinary HTTP request and nginx only
has to forward the `Upgrade` headers. `proxy_read_timeout 3600s` matters: the default is 60s
and nginx would drop the agent's socket every minute — the agent reconnects, so nothing breaks,
but you would churn a reconnect forever.

The service already limits its own public surface to `POST /orders`, `GET /agents` and the
`/agent` upgrade, so no per-path proxy blocks are needed. Only ports 22/80/443 should be open.

### Agent on the restaurant computer

`print-agent/.env`:

```env
PRINT_SERVICE_URL=wss://print.example.com/agent
RESTAURANT_ID=restaurant-1
AGENT_TOKEN=<same as the service>
PRINTER_MODE=escpos
PRINTER_HOST=192.168.1.50
```

Run it unattended with **Task Scheduler** on Windows (trigger *At startup*; action `cmd.exe`
with `/c npm start` and *Start in* set to the agent folder; tick *Run whether user is logged on
or not*; restart every 1 minute on failure). launchd and systemd work the same way. The agent's
dependencies are pure JS, so the same folder runs on any OS.

## Tests

```bash
cd print-service && npm test   # 43 tests
cd print-agent   && npm test   # 13 tests
npm run typecheck              # tsc --noEmit, in either app
```

Built on Node's own test runner — no test framework to install. No printer needed:

| Covered                                                        | Where                     |
| -------------------------------------------------------------- | ------------------------- |
| Order validation, payload limits, numeric id coercion            | `print-service/test/validation.test.ts` |
| Agent registration, wrong token, wrong restaurant id             | `print-service/test/service.test.ts` |
| Order delivery, routing to the right restaurant only            | `print-service/test/service.test.ts` |
| Offline agent, disconnect, reconnect, replaced agent             | `print-service/test/service.test.ts` |
| Print acknowledgement, failed print                             | `print-service/test/service.test.ts` |
| Service token (orders + agent list), oversized body, unknown route    | `print-service/test/service.test.ts` |
| Test page off by default, WS refused off `/agent`                     | `print-service/test/service.test.ts` |
| Notifications: sent, no-printer, skipped on invalid, cannot break an order | `print-service/test/service.test.ts` |
| Telegram request shape, unreachable and rejected API calls           | `print-service/test/telegram.test.ts` |
| Receipt text (identical assertion to the agent suite)                | `print-service/test/receipt.test.ts` |
| Mock receipt format                                             | `print-agent/test/agent.test.ts` |
| Duplicate suppression, failed print retried                      | `print-agent/test/agent.test.ts` |
| Automatic reconnect after the service restarts                   | `print-agent/test/agent.test.ts` |
| Real ESC/POS bytes written to a TCP port, decoded and checked   | `print-agent/test/agent.test.ts` |
| Rejected credentials stop the agent                              | `print-agent/test/agent.test.ts` |

The ESC/POS tests point a `net` server at a real socket and assert on the bytes a printer would
receive, including the paper-cut command — so the hardware path is covered without hardware.

## Current limitations

Known and deliberately out of scope for the MVP:

- **No queue.** An order is only delivered to an agent that is connected right now. If the
  agent is offline the website gets `503` and the order is lost — nothing is retried or stored.
  The website should treat `503` as "not printed" and let a human deal with it.
- **No print-failure feedback to the website.** Failures are logged and visible on
  `GET /agents`, but nothing is pushed back to the order that triggered them.
- **Duplicate protection is in-memory** and lost on agent restart (see above).
- **Orders print concurrently.** Two orders arriving within the second or two a thermal printer
  needs for one will be printed at the same time, and on real hardware the two receipts can
  interleave. Worst case is a garbled receipt, not lost orders. A one-at-a-time print queue in
  the agent would fix it.
- **No printer status.** The agent does not read paper-out or offline flags from the printer.
- **One printer per agent, no routing.** No kitchen/bar split, no printer selection.
- **No authentication for the human side.** No dashboard, no login, no user accounts.
- **No TLS and no rate limiting in the service itself.** TLS is nginx's job, and rate limiting is
  listed under Deploying. Set `SERVICE_TOKEN` before exposing `POST /orders` publicly.
- **Notifications are best-effort.** Telegram failures are logged and dropped; nothing retries
  them, and there is no record of which orders were announced.
- **Dev dependencies are permissive by design.** The `escpos` package is an alpha from 2022.
  It is stable in practice for text receipts and is only loaded when `PRINTER_MODE=escpos`,
  but pin it before this matters more than a weekend.