# Snoopy Voice Receptionist

Customers call a Twilio number and talk to a Gemini Live voice agent for a dry cleaner
("Charlie's Cleaners"). The agent looks up orders and prices and takes messages or order
notes through tools backed by MongoDB Atlas. A teaching agent (planned) grades each call
and improves the voice agent over time. See [docs/PLAN.md](docs/PLAN.md).

## Flow

```
Caller -> Twilio -> POST /voice (TwiML <Connect><Stream>) -> wss /media-stream
       -> mu-law 8k <-> PCM16 (src/services/audio/converter.ts) <-> Gemini Live
       -> tool calls (src/services/gemini/tools.ts) -> DataStore (Atlas or in-memory)
```

## Quick start (one command)

With `GEMINI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER` in `.env`
and ngrok installed and authenticated (`brew install ngrok`, `ngrok config add-authtoken <token>`):

```bash
npm install
npm run live
```

This starts ngrok, sets `PUBLIC_HOST`, points the Twilio number's voice webhook at the tunnel, and
starts the server. Then call the number from a verified phone.

## Run locally

```bash
cp .env.example .env     # set GEMINI_API_KEY; MONGODB_URI is optional
npm install
npm run dev              # http://localhost:3000, GET /health
ngrok http 3000          # then set PUBLIC_HOST to the ngrok hostname
```

In the Twilio console, set the number's voice webhook to `POST https://<host>/voice`.

Without `MONGODB_URI` the app uses an in-memory store seeded with sample orders
and prices. With it, the same data is seeded into Atlas on first connect.

## Tools

`get_order`, `lookup_price`, `list_prices`, `add_order_note`, `take_message`

## Dashboard API

JSON endpoints under `/api` for the dashboard UI (calls are recorded with transcripts and tool calls):

- `GET /api/health` -> `{status:"ok"}`
- `GET /api/stats` -> `{calls, activeCalls, orders, openOrders, messages}`
- `GET /api/calls?limit=50` -> call records, newest first (live calls included)
- `GET /api/calls/:callSid` -> one call record
- `GET /api/orders`, `GET /api/messages` -> arrays
- `GET /api/config` -> `{active, versions}` (company config versions, newest first)
- `PUT /api/config` `{companyName, greeting, context, note?}` -> 201, the new active version (author `manager`)
- `POST /api/config/activate` `{version}` -> the activated version (404 if unknown); this is rollback

The agent is company-agnostic: the company name, greeting and free-text context (business description,
hours, policies, FAQs, tone) are edited from the dashboard and become part of the system prompt.
Every change is a new immutable version (`config_versions` collection); each call records the
`configVersion` that handled it. Writes require the dashboard token when `DASHBOARD_TOKEN` is set.

Set `DASHBOARD_TOKEN` to require an `x-dashboard-token` header (except on `/api/health` and
OPTIONS). `ALLOWED_ORIGINS` (comma-separated, default `*`) controls CORS. When the server is
behind a free ngrok URL, browser fetches must send `ngrok-skip-browser-warning: 1` or ngrok
returns an HTML interstitial; the CORS config allows this header.

## Deployment note

Twilio Media Streams needs a long-lived WebSocket (`/media-stream`). Vercel serverless
functions cannot hold one, so the voice server must run on a WebSocket-capable host
(Render, Railway, Fly.io, or similar). Vercel is a fit for the dashboard UI and APIs.

## Status

Voice loop, tools, and data layer are written and type-check. A full live call has not
been tested yet: it needs a Gemini key, a Twilio number, and a public URL.

## Teaching agent

The teaching agent lives in [teacher/](teacher/). It grades every finished call and writes new
config versions (author `teacher`) that the next call loads. It runs as a separate process next to
this server, against the same MongoDB database: `cd teacher && npm install && npm run watch`.
Team status, data shapes for the dashboard, and known issues: [docs/TEAM_HANDOFF.md](docs/TEAM_HANDOFF.md).
