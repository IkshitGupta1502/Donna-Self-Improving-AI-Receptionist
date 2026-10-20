# Donna: the AI receptionist that teaches itself

Donna answers a small business's phone. After every call, a second AI agent grades the call and rewrites Donna's
rules, knowledge and tools, so the next caller gets a better receptionist. The demo business is a dry cleaner,
CJ's Cleaning Company.

**Demo video:** [Watch Donna on YouTube](https://youtu.be/828BnKVhIm4)

Built at the Harness Engineering & Model Wrangling hackathon (October 2026) for the **Recursive Harnessing**
problem statement: a self-improving agent harness that evolves its own rules, guardrails, context and tool access.

## The problem

Voice agents repeat the same mistakes on every call. Fixing them means an engineer reading transcripts and
rewriting prompts by hand, which a small business cannot do. Worse, a model that "improves itself" with no limits
can invent prices, drift, or break what already worked.

## How Donna works

```
             call                                    after the call
Caller ---> Twilio ---> Voice agent ---------------> Teacher agent
                        (Gemini Live)                (Gemini, grades the call)
                            |                              |
                            | tools, call log              | grades, new rules,
                            v                              v owner questions, new tools
                        +---------------------------------------+
                        |             MongoDB Atlas             |
                        |  orders, customers, calls, versioned  |
                        |  config, grades, improvements, tools  |
                        +---------------------------------------+
                            ^                              |
                            | next call loads the          | owner answers questions,
                            | newest config version        v approves tools, rolls back
                                                     Owner dashboard
```

1. **A customer calls.** Twilio streams the audio to the voice server, which bridges it to Gemini Live. The
   agent looks up orders and prices, creates and cancels orders, schedules pickups, saves customer details and
   takes messages, all through tools backed by MongoDB.
2. **The call is saved** with its transcript, every tool call, and the config version that handled it.
3. **The teacher grades it.** It scores accuracy, task completion, judgment, tool use, tone and brevity, and
   estimates how frustrated the caller was. Every issue must quote the transcript.
4. **The teacher improves the harness.** Depending on what went wrong, it can:
   - add or edit a **behavior rule** (applied automatically as a new config version),
   - ask the owner a short **question** when Donna lacked a business fact, and never guess the answer itself,
   - add a **scenario playbook** entry for an edge case,
   - propose a **new tool** with a mockup and a recipe it has tested, for the owner to enable.
5. **The next call loads the new version.** The owner sees every change, answers questions and approves tools in
   the dashboard, and can roll back to any earlier version in one click.

## Guardrails

The model only proposes. Code decides what reaches the receptionist, and the teacher cannot edit these limits:

- The overall score is computed in code from fixed weights, not by the model.
- An issue is kept only if its quote appears in the transcript; a change needs evidence from real turns.
- At most 3 rule changes per call and 20 rules in total; no near-duplicate rules; locked rules cannot be touched.
- A rule may not contain a number (a price, an hour) that the business never stated.
- The teacher never writes business facts. Missing facts become questions for the owner (at most 2 per call,
  never repeated).
- A tool that changes data must ask the caller to confirm first, and the teacher runs a tool's recipe on its own
  example before enabling it.
- Every change is a new immutable config version, so nothing is overwritten and rollback is one pointer move.

## Tech stack

| Part | Technology |
|---|---|
| Phone line | Twilio Programmable Voice and Media Streams |
| Voice agent | Gemini Live, Node.js and TypeScript (`src/`) |
| Teacher agent | Gemini, TypeScript, zod (`teacher/`) |
| Database | MongoDB Atlas (in-memory fallback for local runs) |
| Dashboards | Static HTML pages (`web/`), no build step |
| Tunnel for local runs | ngrok |

## Quick start

You need Node.js 22, a Gemini API key, a Twilio number, ngrok (`brew install ngrok`, then
`ngrok config add-authtoken <token>`), and a MongoDB Atlas connection string for the teacher.

```bash
git clone https://github.com/gandhiaayush/mongodb_hack && cd mongodb_hack
cp .env.example .env      # fill in the keys below; never commit .env
npm run setup             # installs the server and the teacher
npm run doctor            # checks keys, MongoDB, Twilio and Gemini without a phone call; fix every ✗
npm run seed              # demo orders, a demo caller and a richer company context (dry run without MONGODB_URI)
npm run live              # starts ngrok, points the Twilio webhook at it, the server and the teacher
```

Then call the Twilio number. On a Twilio trial account, only verified phone numbers can call.
`npm run live` also serves both dashboards at `http://localhost:8080`: the Ops dashboard at `/` and the
Donna dashboard at `/donna/`.

### Environment variables (`.env`)

| Variable | Needed for |
|---|---|
| `GEMINI_API_KEY` | Required. Voice agent and teacher |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Phone calls. `npm run live` uses them to set the webhook |
| `PUBLIC_HOST`, `PORT` | Public hostname of the server (set automatically by `npm run live`), port (default 3000) |
| `MONGODB_URI`, `MONGODB_DB` | MongoDB Atlas. Without a URI the server uses an in-memory store and the teacher cannot run |
| `DASHBOARD_TOKEN`, `ALLOWED_ORIGINS` | Optional. Protect the dashboard API and limit CORS |

Useful switches: `TEACHER=off` runs without the teacher; `DASHBOARD_PORT` and `DASHBOARD=off` control the
dashboards.

### Running the pieces separately

```bash
npm run dev                          # voice server only, http://localhost:3000 (GET /health)
ngrok http 3000                      # then set PUBLIC_HOST and the Twilio webhook to POST https://<host>/voice
cd teacher && npm run watch          # teacher only: grades each finished call
cd teacher && npm run demo           # teacher demo on scripted calls, in a separate donna_demo database
```

Other commands: `npm run forget -- "text"` removes a line from the company context (dry run unless
`--apply`); in `teacher/`, `npm run rollback`, `npm run trend`, `npm run tools`, `npm run playbook`,
`npm run context`, and `npm run selftest` for the offline guardrail tests.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | Voice server: Twilio webhook and media stream, audio conversion, Gemini Live session, tools, MongoDB store, dashboard API |
| `teacher/` | Teacher agent: grading, guardrails, versioned config, owner questions, tool proposals, rollback |
| `web/` | Ops dashboard (`index.html`) and Donna dashboard (`donna/`) |
| `scripts/` | `live`, `doctor`, `seed`, `forget` |
| `docs/API.md` | Dashboard API reference (calls, orders, config, grades, improvements, tools, playbook) |
| `docs/HANDOFF.md`, `docs/TEAM_HANDOFF.md` | Build notes, decisions and known issues |
| `docs/PLAN.md` | The original plan |

## MongoDB collections

| Collection | Contents |
|---|---|
| `orders`, `pricing`, `customers`, `appointments`, `messages` | Business data the voice agent reads and writes |
| `calls` | Transcript, tool calls and config version for every call |
| `config_versions`, `config_state` | Immutable versions of the company context and learned rules, and the active pointer |
| `grades`, `improvements` | The teacher's scores and every change it proposed, applied, rejected or rolled back |
| `tool_proposals`, `custom_records`, `playbook` | Tools the teacher designed, the records they save, and scenario playbook entries |

## Deployment note

Twilio Media Streams needs a long-lived WebSocket (`/media-stream`), which serverless hosts such as Vercel cannot
hold. Run the voice server on your machine with ngrok, or on Render, Railway, Fly.io or similar. The dashboards are
static and can be hosted anywhere.

## Known limitations

- Frustration is estimated from the transcript text only, not from the audio.
- Gemini's free tier allows a small number of requests per day per model, and the teacher makes one per call.
- Google Calendar booking (PR #10, PR #5) and Stripe (PR #15) are in open pull requests, not in this branch.
- See `docs/HANDOFF.md` for what has and has not been verified end to end.

## Team

- Aayush Gandhi
- Ikshit Gupta
- Vishnu Vishak Srinivas
