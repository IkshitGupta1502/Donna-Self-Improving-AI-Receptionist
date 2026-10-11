# Donna AI: Voice Receptionist with Recursive Self-Improvement (RSI)

Status: DRAFT, decisions made, scoped to a 3-hour build. English only. Callers are customers.

## 1. Summary

Donna AI is a Notion-style workspace. This hackathon build adds a **voice receptionist**
that answers phone calls for a workspace, using the workspace's knowledge as context.
A **teaching agent** grades every successful call and writes concrete improvements for the
voice agent (prompt, context, MongoDB data, tools). Approved improvements are versioned and
applied, so the receptionist gets better with each call.

## 2. Components

| Component | Role |
|---|---|
| **Twilio** | Phone number, call handling, bidirectional audio via Media Streams (WebSocket, mu-law 8 kHz) |
| **Voice bridge** (our server) | Receives the Twilio stream, transcodes audio to/from Gemini Live format, executes tool calls, logs everything |
| **Gemini Live** (Gemini 3.1 Flash Live) | Realtime speech-to-speech conversation with function calling |
| **MongoDB Atlas** | Knowledge base, caller and contact records, call logs, prompt/config versions, improvement queue, vector search for retrieval |
| **Teaching agent** | Runs after each call: grades it against a rubric, proposes typed improvements |
| **Dashboard** (minimal) | Calls, grades, proposed/applied improvements, approve/reject, score trend over time |

## 3. Architecture

```
Caller ──PSTN──> Twilio ──Media Streams (WS)──> Voice bridge ──Live WS──> Gemini Live
                                                   │  │
                               tool calls ◄────────┘  └──> Atlas (context, logs)
                                                   │
                         call ends ───────────────> Teaching agent
                                                   │  grade + improvements
                                                   ▼
                                  Atlas: improvements (proposed → approved → applied)
                                                   │
                         next call loads latest approved config version
```

Key pieces:

- **Call start:** bridge loads the workspace's active `config_version` (system prompt, tool
  set, voice settings) plus retrieved context (Atlas Vector Search over workspace docs and
  the caller's history) and opens a Gemini Live session with it.
- **During call:** Gemini calls tools such as `lookup_contact`, `check_availability`,
  `book_appointment`, `take_message`, `search_knowledge`. The bridge executes them against
  Atlas and returns results.
- **After call:** the bridge writes a `calls` document (transcript, tool trace, duration,
  outcome) and enqueues a grading job.

## 4. Data model (Atlas)

| Collection | Contents |
|---|---|
| `workspaces` | Workspace settings, business hours, phone number mapping |
| `documents` | Notion-style pages/blocks, with `embedding` for vector search |
| `contacts` | Callers and customers (phone, name, history summary) |
| `appointments`, `messages` | Outputs of receptionist tools |
| `calls` | One per call: transcript turns, tool invocations, latency, outcome, `config_version_id` used |
| `grades` | Teacher output per call: score per rubric dimension, rationale |
| `config_versions` | Immutable versions of the voice agent's prompt, tool schema, and retrieval settings |
| `improvements` | Teacher suggestions: `type` (prompt, context, data, tool, schema), `payload`, `status` (proposed / approved / rejected / applied / rolled_back), `source_call_ids` |
| `evals` | Replay test set: frozen calls plus expected outcomes, used to test new versions before they ship |

## 5. The RSI loop

1. **Call completes.** The bridge logs it with the `config_version_id` that handled it.
2. **Success check.** Deterministic outcome first (see §6). Only successful calls get the full
   teaching pass. Failed calls get a lighter failure analysis, so they are not ignored.
3. **Teaching pass.** The teaching agent receives the transcript, tool trace, outcome, the
   current config version, and a fixed rubric. It returns:
   - a score per dimension (accuracy, tool use, task completion, tone, latency/brevity)
   - typed improvements, each with evidence (the turn numbers that motivated it)
4. **Routing:**
   - `context` and `data` improvements (add a FAQ doc, fix a contact field) are low-risk. Auto-apply, with an audit trail.
   - `prompt`, `tool`, and `schema` improvements change behaviour or the data model. They need approval, or passing the eval set first.
5. **Eval gate.** A candidate config version is replayed against `evals` (frozen caller
   utterances with expected tool calls and outcomes). It is promoted only if it does not
   regress. This is the main protection against a self-improving loop that drifts.
6. **Promotion and rollback.** Promotion sets the workspace's active `config_version`.
   Rollback is one pointer change. Every change records its source calls.

Guardrails: the teaching agent cannot edit its own rubric or the eval gate. Caps on how many
improvements can be applied per day. Every applied change is visible in the dashboard.

## 6. Defining "successful call"

RSI needs an objective signal. Proposed outcome labels:

- **booked:** an appointment was created and confirmed by the caller
- **message_taken:** a message was stored with the caller's callback number
- **answered:** the caller's question was answered from the knowledge base (no escalation)
- **escalated / failed:** caller asked for a human, hung up before the goal, or the tool failed

Success = one of the first three, plus no tool errors. The teaching agent's grade is then a
quality score on top of the outcome (tone, efficiency, accuracy), not the success test itself.

## 7. Structure (adapted from gandhiaayush/dry-cleaning-voice-agent)

Reuse its layout and the working Twilio to Gemini Live bridge. Swap Notion and Supabase for Atlas.

- `src/config.ts`: zod-validated env (copied pattern)
- `src/routes/voice.ts`, `src/routes/mediaStream.ts`: Twilio webhook and media WebSocket (copied pattern)
- `src/services/gemini/liveSession.ts`, `audioConverter.ts`, `tools.ts`, `systemPrompt.ts`: Gemini Live session, mu-law to PCM16 conversion, tool declarations, prompt built from the active config version
- `src/services/mongo/`: Atlas client, collections, config versions
- `src/services/teacher/`: Claude grading pass and improvement application
- `public/index.html`: dashboard with score timeline and improvement log

## 8. 3-hour plan

| Time | Work |
|---|---|
| 0:00 to 0:20 | Scaffold from reference repo, Twilio number, Atlas cluster, env keys |
| 0:20 to 0:50 | Voice loop working end to end with Gemini Live, one tool (`take_message`) |
| 0:50 to 1:30 | Atlas: seeded workspace knowledge, `calls` log, `book_appointment` and `check_hours` tools |
| 1:30 to 2:15 | Teacher: at call end, Claude grades the call and proposes changes. Changes are written to `config_versions` and the next call loads them |
| 2:15 to 2:45 | Dashboard: score and frustration timeline, improvement log with one-click rollback |
| 2:45 to 3:00 | Scripted demo: call 1 scores low, the teacher applies a fix, call 2 succeeds. Record the demo |

Cut for time: eval gate, vector search (the knowledge base is small enough to load into the prompt), change streams (the bridge calls the teacher directly at call end), and any teacher-created tools (proposal only, shown in the dashboard).

## 9. Decisions

1. **Callers are customers.** The rubric and tools are customer-facing: booking, messages, hours, and FAQs.
2. **Success and frustration.** Success stays deterministic: booked, message taken, or answered from the knowledge base, with no escalation and no tool errors. Frustration is a separate signal scored by the teacher. It uses transcript cues (repeated questions, "this isn't working", requests for a human), interruption count, and loudness or speech rate if they are cheap to compute from the audio. Frustration is an estimate on 8 kHz phone audio, so the dashboard shows it as a trend, not a verdict. Audio-based emotion scoring is a stretch goal.
3. **Auto-apply.** `context` and `data` changes apply automatically. `prompt` changes also apply for the demo, each with a one-click rollback. `tool` and `schema` proposals stay as proposals. Every applied change records its source call and is visible on the timeline.
4. **Teacher model.** Use a different model from the voice agent. Proposed: `claude-sonnet-5-5` for grading. The reference repo already uses the Anthropic SDK.
5. **Atlas.** Use Atlas as the document store with direct writes from the bridge. The teacher is called directly at call end. Change streams and vector search are stretch goals.
6. **Timeline.** 3 hours. English only.

## 10. Risks

- **Latency:** realtime audio through the bridge. Keep tool calls simple and fast.
- **Audio format mismatch:** Twilio mu-law 8 kHz vs Gemini PCM16 16 kHz in and 24 kHz out. The reference `audioConverter.ts` already handles this.
- **Self-improvement drift:** with auto-apply, rollback and the change log are the main protection. The teacher cannot change its own rubric.
- **Scope:** if the voice loop is not working by 0:50, drop the teacher and show the timeline with scripted scores.
- **Model names:** confirm the exact Gemini Live and Claude model IDs before wiring them in.
