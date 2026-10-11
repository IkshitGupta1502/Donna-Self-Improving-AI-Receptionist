# Handoff: Voice Receptionist (MongoDB Harness Engineering Hackathon)

Read this first when picking the project up in a new session or on a new machine.
Plan and rationale: [PLAN.md](PLAN.md). Run instructions: [../README.md](../README.md).

## Where things are

- Repo: https://github.com/gandhiaayush/mongodb_hack
- Branch: `claude/mongodb-harness-hackathon-7hdril` (`main` was created from the plan commit; it has only the plan)
- Draft PR: https://github.com/gandhiaayush/mongodb_hack/pull/1
- Reference project (read-only inspiration, same author): https://github.com/gandhiaayush/dry-cleaning-voice-agent
- Collaborator to add: `IkshitGupta1502` (not yet added; needs repo Settings -> Collaborators)

## What it is

A phone number that answers as a dry cleaner ("CJ's Cleaners"). Customers call; a Gemini
Live voice agent looks up orders and prices, adds order notes, and takes messages. The end goal
is a teaching agent that grades each call and improves the voice agent over time (RSI).
Decisions already made: callers are customers, English only, 3-hour build, success judged by
tool outcomes, frustration tracked as a separate estimate, Claude as teacher (different model
from the voice agent), auto-apply context/data/prompt changes with rollback.

## What is built

| Area | Files | State |
|---|---|---|
| Twilio webhook | `src/routes/voice.ts`, `src/utils/twiml.ts` | Returns `<Connect><Stream>` TwiML and passes caller ID as a stream parameter |
| Audio bridge | `src/routes/mediaStream.ts`, `src/services/audio/converter.ts` | mu-law 8 kHz <-> PCM16 16/24 kHz. Buffers up to ~10 s of caller audio while Gemini connects |
| Voice agent | `src/services/gemini/liveSession.ts`, `systemPrompt.ts`, `tools.ts` | Gemini Live, model `gemini-3.1-flash-live-preview` (constant in `liveSession.ts`). Tools: `get_order`, `lookup_price`, `list_prices`, `add_order_note`, `take_message` |
| Data | `src/services/data/store.ts`, `seed.ts` | `DataStore`: in-memory (default) or MongoDB when `MONGODB_URI` is set. Seeds 6 sample orders and 11 prices. Collections: `orders`, `pricing`, `messages`, `calls`, `config_versions` (immutable company config versions, unique `version`), `config_state` (`{_id:"active", version}` pointer) |
| Call recording | `src/services/calls/recorder.ts` | Merges transcript fragments, records tool calls, saves on start/end and at most every 2 s while active |
| Company config | `store.ts`, `seed.ts`, `systemPrompt.ts`, `api.ts` | Company name, greeting and free-text context are edited from the dashboard (`GET/PUT /api/config`, `POST /api/config/activate`) and injected into the system prompt at call start. Versions are immutable, authors `manager`/`teacher`/`system`, any version can be re-activated. Calls record `configVersion`. Teaching agent should write versions with author `teacher` via `saveConfigVersion` |
| Dashboard API | `src/routes/api.ts` | `/api/health, stats, calls, calls/:callSid, orders, messages`. CORS allows `ngrok-skip-browser-warning`. Optional `DASHBOARD_TOKEN`, `ALLOWED_ORIGINS` |
| Dashboard UI | `web/index.html`, `config.js`, `vercel.json` | Static, no build. Brand name "Hanger" is a placeholder constant in `web/config.js`. Tabs: Overview, Live Calls, Orders, Messages, Improvements (placeholder) |

## Deployment architecture

- **Voice server: runs on the owner's laptop** behind ngrok (`npm run dev`, `ngrok http 3000`). Vercel cannot host it because Twilio Media Streams needs a persistent WebSocket.
- **UI: Vercel**, project root directory `web`. The user pastes the ngrok URL and dashboard token into the UI's Settings panel (stored in browser localStorage).
- ngrok free URLs change on restart: re-paste in the UI, update `PUBLIC_HOST` in `.env`, and update the Twilio webhook.

## Environment (.env, gitignored; copy from `.env.example`)

`GEMINI_API_KEY` (required), `PUBLIC_HOST` (ngrok hostname, no scheme), `PORT` (3000),
`TWILIO_AUTH_TOKEN` (optional, enables signature validation), `DASHBOARD_TOKEN` (recommended),
`ALLOWED_ORIGINS` (set to the Vercel URL), `MONGODB_URI` / `MONGODB_DB` (optional).
No secrets are committed. `.env` exists only where someone creates it; the one in the cloud
session container is blank and not on the owner's laptop.

## Run it

```bash
git clone https://github.com/gandhiaayush/mongodb_hack && cd mongodb_hack
git checkout claude/mongodb-harness-hackathon-7hdril
cp .env.example .env        # fill in GEMINI_API_KEY etc.
npm install && npm run dev
ngrok http 3000             # put the hostname in PUBLIC_HOST, restart
# Twilio: number -> voice webhook -> POST https://<ngrok-host>/voice
npm run check               # type-check
```

Good first calls: "check order ORD-0010", "how much is expedited for a suit", "I want to leave a message".

## Verified vs not verified

Verified:
- `tsc --noEmit` passes.
- Server starts; `/health`, `/voice` TwiML (with caller ID), and all `/api/*` endpoints respond correctly with and without a token; CORS preflight works.
- Tools run against the in-memory store (order lookup, partial price match, notes, messages).
- Transcript fragment merging (script test).
- Dashboard loads in demo mode at 1280 px and 390 px with no console errors, and connects to the real local API with a token.

Not verified:
- **Any live call.** Needs a Gemini key, a Twilio number, and ngrok. Nothing has been heard end to end yet.
- The MongoDB store against a real Atlas cluster.
- Dashboard through a real ngrok URL, and on Vercel.
- The Gemini model name and audio behavior (barge-in, latency, voice quality).

## Known issues and gotchas

- Model ID `gemini-3.1-flash-live-preview` was copied from the reference repo; if connect fails, check it first.
- `get_order` by name is a substring search; two customers can share a name.
- The first agent greeting is a scripted text cue; interruptions during it are untested.
- Caller audio buffer is capped (500 frames, about 10 s); longer connect times drop the excess.
- The `web/` UI has no auth of its own; protection is `DASHBOARD_TOKEN` on the API, and the token is held in browser localStorage.
- Commits made so far include a `Co-Authored-By` model trailer from the session settings; amend if the repo should not carry it.
- Draft PR #1 merges into a `main` that was created only to host the PR.

## Next steps (in order)

1. First live call: fix whatever breaks (audio, model name, webhook). Capture a recorded call in the dashboard.
2. Add `IkshitGupta1502` as a collaborator.
3. Deploy `web/` to Vercel (root dir `web`) and set `ALLOWED_ORIGINS`.
4. Teaching agent (the RSI loop), see PLAN.md sections 5 to 8:
   - `src/services/teacher/`: on call end, send transcript and tool trace to Claude (`claude-sonnet-5-5` proposed); output scores, frustration estimate, and typed improvements.
   - `config_versions` collection: versioned system prompt and context docs; `liveSession.ts` loads the active version at call start and tags each call with its version id.
   - Auto-apply `context`/`data`/`prompt` changes with one-click rollback; keep `tool`/`schema` as proposals.
   - Fill the dashboard's Improvements tab with a score and frustration timeline and the change log.
5. Scripted demo: a call that fails, the teacher applies a fix, the next call succeeds.
6. Optional: switch to Atlas (`MONGODB_URI`), then vector search and change streams as stretch goals.

---

## Update: where things stand now (supersedes "Next steps" above where they conflict)

### New since the first handoff
- `npm run live`: starts ngrok, sets `PUBLIC_HOST`, points the Twilio number's voice webhook at the tunnel (needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` in `.env`), then starts the server. `scripts/live.ts`.
- `npm run doctor`: pre-flight check with no phone call. Checks `.env` names, Mongo connection, Twilio credentials and the number's webhook, and a real Gemini Live session using production settings. `scripts/doctor.ts`.
- `npm run seed`: seeds demo data. Upserts 3 orders (ORD-0101..0103) for caller `+19255511546` and adds a richer company-context version ("Demo context", becomes the active config; roll back from the dashboard). Uses `MONGODB_URI` if set, otherwise runs against memory as a dry run. `scripts/seed-demo.ts`. Override the number with `--phone=...`. `DataStore` gained `upsertOrder`.
- Company Context tab and versioned config (`config_versions`, `config_state`); every call records the `configVersion` used.
- Gemini close reason is now logged: `[gemini] session closed code=... reason=...`.

### The open problem: first live call connects then hangs up immediately
- Twilio reached the server and the stream started, but the call dropped within ~1 s.
- Reproduced locally: with an invalid Gemini key, `ai.live.connect()` never resolves, but the close callback fires (`code=1007 reason=API key not valid`), and the bridge closes the Twilio socket without logging. The close logging is now added.
- Real cause on the owner's setup is NOT yet confirmed. Suspects, in order: Gemini key or model name (`MODEL` in `src/services/gemini/liveSession.ts`), Mongo connection failure, Twilio signature check (wrong `TWILIO_AUTH_TOKEN`).
- Next action: on the laptop run `git pull && npm install && npm run doctor`, read the first `✗` line, fix it, then `npm run live` and call again.

### Environment names (common mistakes)
`TWILIO_PHONE_NUMBER` (not `TWILIO_NUMBER`), `TWILIO_ACCOUNT_SID` starts with `AC`. The owner's Twilio number is +1 605 476 1503 and the demo caller is +1 925 551 1546 (a verified caller; Twilio trial accounts only accept verified callers). ngrok domain: `bruising-boogieman-unreal.ngrok-free.dev`.

### What the assistant can and cannot reach (why "before it could" is not true)
- The cloud session container holds only a clone of this repo from GitHub. It has no access to the owner's laptop, `.env`, MongoDB Atlas, Twilio console or ngrok, and its network blocks most outside hosts.
- Everything that touches those (keys, Atlas, Twilio, ngrok, live calls) has to run on the owner's laptop. A Claude Code session running locally (for example in VS Code) can do that directly.

### Other work in flight
- RSI / teaching agent is being built by another agent or teammate. It should write config versions with `saveConfigVersion({... author: "teacher"})` and roll back with `activateConfigVersion`. Pull this branch before starting so store/API changes don't conflict.
- Planned, not started: generic tool registry (query/create records, SMS, Stripe payment links) and industry packs.
- Pending admin: add `IkshitGupta1502` as a collaborator.

### Resume checklist (laptop or VS Code)
```bash
git clone https://github.com/gandhiaayush/mongodb_hack && cd mongodb_hack
git checkout claude/mongodb-harness-hackathon-7hdril && git pull
cp .env.example .env       # fill in keys (never commit .env)
npm install
npm run doctor             # fix every ✗
npm run seed               # once, with MONGODB_URI set
npm run live               # then call the Twilio number from a verified phone
```
