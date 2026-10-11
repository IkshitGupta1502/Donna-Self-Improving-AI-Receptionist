# Snoopy AI: Voice Receptionist with Recursive Self-Improvement (RSI)

Status: DRAFT for brainstorming. Open decisions are listed at the end.

## 1. Summary

Snoopy AI is a Notion-style workspace. This hackathon build adds a **voice receptionist**
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

## 7. Phased plan

**Phase 0: Setup (hour 0 to 1)**
- Repo scaffold: `bridge/` (Node or Python server), `teacher/`, `dashboard/`, `docs/`
- Twilio number, Atlas cluster, Gemini API key, secrets in env (never committed)

**Phase 1: Thin voice loop**
- Call the Twilio number, speak to Gemini Live, hear the reply. No tools, no RSI.
- Verify audio transcoding and barge-in (caller interrupting) work.

**Phase 2: Context and tools**
- Seed a demo workspace (business hours, services, FAQ docs) into Atlas
- Add `search_knowledge` (vector search), `lookup_contact`, `take_message`, `book_appointment`
- Log every call with transcript and tool trace

**Phase 3: Teaching agent (offline first)**
- Run grading on logged calls: rubric scores plus typed improvements
- Show results in a simple dashboard table. No auto-apply yet.

**Phase 4: Closed loop**
- Versioned `config_versions`, auto-apply for `context` and `data`
- Eval set built from the first ~20 calls, with the regression gate
- Approve/reject for prompt and tool changes

**Phase 5: Demo**
- Scripted demo: call 1 scores low, teacher proposes a fix, fix is applied, call 2 succeeds.
  Show the score trend. This is the core story for judges.

## 8. Risks

- **Latency:** realtime audio through a bridge adds delay. Keep the bridge thin, and avoid blocking tool calls on slow retrieval.
- **Audio format mismatch:** Twilio uses mu-law 8 kHz, Gemini Live uses PCM 16 kHz in and 24 kHz out. Resampling must be correct, or the audio will be garbled.
- **Self-improvement drift:** mitigated by the eval gate, the rate cap, and the rule that the teacher cannot change its own rubric.
- **Scope creep:** the Notion-style editor is not needed for the demo. The workspace can be seeded through a script or a simple form.
- **Model names:** confirm exact Gemini Live model IDs and availability in the Gemini API before wiring them in.

## 9. Open decisions (for brainstorming)

1. **Who calls?** Snoopy's end customers calling a business, or internal staff calling the workspace? This changes the rubric and tools.
2. **Success metric:** do the four outcome labels in §6 match what you want to show judges?
3. **Auto-apply scope:** is auto-applying `context` and `data` changes acceptable, or should everything require approval for the demo?
4. **Teacher model:** Gemini (same vendor, simpler), or a different model for independence? I lean toward a separate model so it is not grading its own output.
5. **Atlas features:** confirm which Atlas features we will use: vector search only, or also change streams for triggering the teacher, which would make the loop event-driven.
6. **Timeline:** how long is the hackathon build window? This decides how much of Phase 4 is realistic.
7. **Language and voice:** English only? Which voice?
