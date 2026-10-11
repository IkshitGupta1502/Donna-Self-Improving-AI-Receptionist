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

## Deployment note

Twilio Media Streams needs a long-lived WebSocket (`/media-stream`). Vercel serverless
functions cannot hold one, so the voice server must run on a WebSocket-capable host
(Render, Railway, Fly.io, or similar). Vercel is a fit for the dashboard UI and APIs.

## Status

Voice loop, tools, and data layer are written and type-check. A full live call has not
been tested yet: it needs a Gemini key, a Twilio number, and a public URL.
