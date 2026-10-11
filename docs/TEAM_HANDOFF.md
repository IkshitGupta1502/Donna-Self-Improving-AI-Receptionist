# Team handoff: teaching agent

Written 2026-10-11 for Aayush (voice bridge), the dashboard/UI owner, and Ikshit (teacher).
Submission is due 5:00 PM PT today.

Other docs: [HANDOFF.md](HANDOFF.md) (bridge), [PLAN.md](PLAN.md) (original plan),
[../teacher/CLAUDE.md](../teacher/CLAUDE.md) (full teacher spec), [../teacher/README.md](../teacher/README.md) (run commands).

## 1. Where things stand

| Piece | Owner | Where | State |
|---|---|---|---|
| Voice bridge, tools, company config, dashboard shell | Aayush | repo root, `src/`, `web/` | Built. No live call verified yet (see HANDOFF.md) |
| Teaching agent | Ikshit | `teacher/` (this PR) | Built and tested locally. Not yet run against Atlas |
| RSI harness (policy, apply, rollback, `/api/harness`) | Aayush | PR #2, branch `claude/eager-mccarthy-9uqcw3` | Draft. Overlaps with `teacher/`. **Decision needed, see section 2** |
| Dashboard Improvements tab | UI owner | `web/index.html` | Placeholder. Data contract in section 6 |

The loop that works today, with no change to the bridge:

```
call ends -> bridge saves the call in `calls` (status "completed")
          -> teacher (npm run watch) sees a completed call with no grade
          -> Gemini grades it; guardrails in code filter what it proposes
          -> teacher writes `grades`, `improvements`, and a new `config_versions` document (author "teacher")
          -> teacher moves the `config_state` pointer
next call -> bridge loads the new version; the learned rules are in its system prompt
```

## 2. Decision needed first: `teacher/` and PR #2 overlap

Two pieces now do the same job (decide what to apply, write a config version, roll back):

| | `teacher/` (this PR) | PR #2 harness |
|---|---|---|
| Real grading model | Yes, Gemini `gemini-3.8-flash` | No, `mockTeacher` only; `setTeacher` is never called |
| Works with the current default branch | Yes, verified against its `store.ts`, `recorder.ts`, `systemPrompt.ts` | No. It branched before the company config commits and changes the same files (`store.ts`, `systemPrompt.ts`, `liveSession.ts`, `recorder.ts`) |
| Config model | The bridge's company config. Rules are a text block inside `context` | Its own `AgentConfig` (`versionId`, `rules`, `docs`) in the same `config_versions` collection |
| Changes business facts and prices on its own | Never. Missing facts become questions for the owner | Yes (`context` docs and `upsert_price` auto-apply) |
| HTTP API for the dashboard | No | Yes, `/api/harness/*` |

**They cannot run in the same database as they are.** Both write `grades` and `improvements` with different shapes, and PR #2 puts a unique index on `config_versions.versionId`, which the bridge's and the teacher's documents do not have. The second document without that field fails with `E11000 duplicate key`.

Options:
- **A (recommended for today): use `teacher/` with the default branch and leave PR #2 unmerged.** It is the only path with a real grader that has been run end to end. The UI reads the teacher's collections (section 6).
- **B: merge PR #2 and plug the Gemini judge in through `setTeacher`.** Needs PR #2 rebased onto the company config work, plus an adapter from the teacher's judge output to `TeacherReportSchema` (scores 0 to 1 instead of 0 to 10, camelCase names, `add_rule` payloads). The teacher's own apply and rollback code would then be dropped. This is the cleaner long-term shape but is several hours of untested work.

## 3. How to run it

Both sides must use the same Atlas database.

1. Atlas: the cluster `Cibus-0` was auto-paused. Resume it, add a database user, and allow your IP (Database & Network Access).
2. Bridge: set `MONGODB_URI` and `MONGODB_DB=snoopy` in the root `.env`, then run it as usual. Without `MONGODB_URI` the bridge keeps calls in memory and the teacher sees nothing.
3. Teacher:
   ```
   cd teacher
   npm install
   # create teacher/.env:
   #   MONGODB_URI=<same string as the bridge>
   #   MONGODB_DB=snoopy
   #   GEMINI_API_KEY=<key>
   #   GEMINI_TEACHER_MODEL=gemini-3.8-flash
   npm run selftest     # offline checks, no keys needed
   npm run demo         # 3 fake calls in a separate database, donna_demo
   npm run watch        # grade every finished call from the bridge
   ```

Other commands: `npm run teach <callSid>`, `npm run answer <improvementId> <answer>`, `npm run rollback`, `npm run trend`, `npm run context` (prints the context the receptionist currently gets).

`npm run demo` and `npm run seed` only touch `donna_demo`. `seed` refuses any database whose name does not end in `_demo`, because it wipes the collections.

## 4. What is done and how it was checked

Done:
- Grading: one Gemini call per call. Scores for accuracy, tool use, task completion, tone, brevity (0 to 10), and a frustration estimate. The overall score is computed in code with fixed weights.
- Guardrails in code: every issue needs an exact transcript quote; every change needs evidence turns; at most 3 rule changes per call, 20 rules, 300 characters each; no near-duplicate rules; no number that is not already in the config; locked rules cannot be touched; the teacher never edits the company's own text.
- Rule changes are applied automatically as a new config version. Missing facts become open questions for the owner. Tool and schema ideas are stored as proposals only.
- Rollback: manual (`npm run rollback`) and automatic. Automatic rollback fires when the last 2 graded calls on a teacher-made version average below the parent version's average. The reason is stored on the affected improvements.
- Owner answers: `npm run answer` appends the answer to the company text as a new version with author `manager`.
- `npm run watch`: grades finished calls with no grade, oldest first, up to 3 attempts each.

Checked:
- `npm run typecheck` and `npm run selftest` pass.
- `npm run demo` with the real Gemini judge on a temporary local MongoDB. Result: the call with invented facts scored accuracy 2 and produced a rule plus two owner questions; the looping call scored task completion 0 and frustration 9 and produced a rule; the clean call scored 10 with no changes.
- The full flow (grade, apply, automatic and manual rollback, owner answer, watch) with a stub judge against the bridge's real `store.ts`, `recorder.ts` and `systemPrompt.ts` on a temporary local MongoDB. The learned rule appeared in the output of the bridge's `buildSystemPrompt`.

Not checked:
- Anything against the real Atlas cluster.
- A real phone call end to end.
- Grading quality on real dry cleaner calls. The rubric has only been run on the three salon fixtures.

## 5. How the teacher uses the bridge's collections

| Collection | Owner | Teacher's use |
|---|---|---|
| `calls` | bridge | Read only. Picks up `status: "completed"`. Never written |
| `config_versions` | bridge | Inserts new versions in the bridge's shape, `author: "teacher"`, plus two extra fields the bridge ignores: `parentVersion`, `sourceCallSid` |
| `config_state` | bridge | Moves `{ _id: "active" }.version` |
| `grades` | teacher | One per call, `_id` = callSid |
| `improvements` | teacher | One per proposal, `_id` = `<callSid>_imp<N>` |

**Learned rules live inside the config's `context` text.** The bridge's config has no field for rules, so the teacher keeps them in a block at the end of `context`:

```
LEARNED RULES (added by the teaching agent after reviewing calls; follow every one):
- (r1, behavior) If a caller asks about a service, price, or policy not listed in your business information, explain that you do not have that detail and offer to take a message.
END OF LEARNED RULES
```

Consequences:
- The rules reach the receptionist through the existing "ABOUT THE BUSINESS" section of the prompt.
- They show in the dashboard's Company Context editor, history and diff. A manager can edit or delete a rule there. Adding `, locked` after the kind (`(r1, behavior, locked)`) stops the teacher from changing it.
- Please keep the two marker lines and the `- (id, kind) text` line format. A line inside the block that does not match is treated as company text.
- Everything outside the block is the company's text. The teacher never changes it.

The teacher derives two things the bridge does not record: turn numbers (transcript index plus one) and an outcome label from tool results (`message_taken`, `failed`, or `answered`).

## 6. For the UI owner: data for the Improvements tab

The teacher has no HTTP server. The simplest route is two read endpoints in the bridge's `src/routes/api.ts` that return these collections as they are.

`grades`, one per graded call. Sort by `created_at` ascending for the timeline:
```json
{
  "_id": "CA123...", "call_id": "CA123...", "config_version_id": "v1",
  "outcome": "answered",
  "scores": { "accuracy": 2, "tool_use": 10, "task_completion": 4, "tone": 9, "brevity": 10 },
  "overall": 5.6, "frustration": 0,
  "rationale": "The agent invented a walk-in policy and a price...",
  "issues": [{ "type": "invented_fact", "turn": 4, "quote": "A balayage is $120.", "explanation": "..." }],
  "model": "gemini-3.8-flash", "created_at": "2026-10-11T19:50:00.000Z"
}
```
- All scores and `frustration` are 0 to 10. `overall` is one decimal.
- `config_version_id` is `"v" + version`, or null if the call had no `configVersion`. Use it to mark on the timeline where the config changed.
- `frustration` is an estimate from the transcript text. Show it as a trend.

`improvements`, one per proposal, including rejected ones:
```json
{
  "_id": "CA123..._imp1", "source_call_ids": ["CA123..."],
  "type": "prompt", "status": "applied",
  "payload": { "op": "add", "rule_id": "r3", "rule_kind": "behavior", "text": "If a caller asks about..." },
  "evidence_turns": [2, 4], "reason": "The agent stated a price that is not on file.",
  "applied_in_config_id": "v2", "created_at": "2026-10-11T19:50:00.000Z"
}
```

| `type` | Meaning | What to show |
|---|---|---|
| `prompt` | A rule change (`payload.op`: `add`, `modify`, `remove`) | `payload.text`, status badge, `applied_in_config_id` |
| `context` | A fact the agent lacked. `payload.question` is for the owner | The question with an answer box while `status` is `proposed`; `payload.answer` once applied |
| `tool`, `schema` | An idea for a new tool or data field | `payload.text`, always `proposed` |

| `status` | Meaning |
|---|---|
| `applied` | In effect since `applied_in_config_id` |
| `proposed` | Waiting for a person (owner question, or tool/schema idea) |
| `rejected` | Blocked by a guardrail. `rejected_reason` says which |
| `rolled_back` | Its version was rolled back. `rolled_back_reason` says why (`manual rollback` or `auto: ...`) |

Suggested screen: a line chart of `overall` and `frustration` per call; a list of improvements, newest first, with type, status, text or question, reason, and a link to the source call; open owner questions at the top.

Write actions are not available over HTTP yet:
- **Answer an owner question**: only `npm run answer <improvementId> <answer>` today. An endpoint is to-do item 4.
- **Roll back**: the existing "activate version" button in the Company Context tab already moves the pointer and works. It does not mark the improvements as `rolled_back`; `npm run rollback` does.

## 7. For Aayush

1. Decide section 2 (A or B).
2. Run the bridge with `MONGODB_URI` set so the teacher can see calls. Share the connection string or add a database user for Ikshit.
3. Recorder race in `src/services/calls/recorder.ts`: if a periodic save is in flight when the call ends, it can land after the final save and overwrite it. The call then stays `status: "active"` in the database and is never graded, and the last transcript text can be lost. Fix: have `end()` wait for any in-flight flush before the final one (keep the last flush promise and await it).
4. `PUT /api/config` rejects a `context` over 8000 characters. The rules block counts toward that (up to 20 rules of 300 characters). Raise the limit if a manager cannot save.
5. Nothing needs to call `teach` from the bridge. If you prefer an immediate trigger over the 3 second poll, that is possible later, but the teacher is ESM and the bridge is CommonJS, so it would need a small HTTP hook, not an import.
6. The repo's default branch is `claude/mongodb-harness-hackathon-7hdril`, and `main` has only the plan. Judges will see the default branch, so everything final should be merged there (or into `main`, with `main` set as default).

## 8. To do, in order

| # | Task | Owner |
|---|---|---|
| 1 | Resume the Atlas cluster, create a database user, put the URI in both `.env` files | Aayush / Ikshit |
| 2 | Run `npm run demo` in `teacher/` against Atlas | Ikshit |
| 3 | First live call with `npm run watch` running; check the grade and the next call's prompt | all |
| 4 | Read endpoints for `grades` and `improvements`, and an answer endpoint | Aayush / UI owner |
| 5 | Improvements tab (section 6) | UI owner |
| 6 | Fix the recorder race (section 7, item 3) | Aayush |
| 7 | Check the rubric on real dry cleaner calls and tune `teacher/src/services/teacher/judge.ts` | Ikshit |
| 8 | Demo script: a call that goes wrong, the teacher adds a rule, the next call goes right | all |
| 9 | Merge everything into the default branch before 5:00 PM | Aayush |

Optional: rewrite the teacher's demo fixtures as dry cleaner calls (they are a hair salon today, in a separate database); SMS to the owner for open questions; an eval gate before a new version goes live.

## 9. Errors you may hit

| Symptom | Cause | Fix |
|---|---|---|
| `MONGODB_URI is not set` | No `teacher/.env` | Create it (section 3) |
| `Server selection timed out` | Cluster paused, or your IP is not allowed | Resume the cluster; add your IP in Atlas |
| `bad auth` / `Authentication failed` | Wrong user or password, or special characters in the password | Recreate the user with a generated password |
| `no active config in db "snoopy"` | The bridge has never started against this database | Start the bridge once with `MONGODB_URI` set |
| Teacher never grades anything | Bridge is on its in-memory store, or the call is still `active` | Set `MONGODB_URI` for the bridge; see the recorder race |
| `teacher judge failed twice: ... 503 ... high demand` | Gemini overloaded. Seen twice today | `watch` retries each call 3 times; restart it to retry again |
| `404 ... no longer available to new users` | Old model ID | `GEMINI_TEACHER_MODEL=gemini-3.8-flash` |
| `E11000 duplicate key` on `config_versions`, `grades` or `improvements` | PR #2's harness has run in the same database | Section 2. Use a separate database for one of them |
| `refusing to seed "snoopy"` | `seed` run against a real database | Use `npm run seed` or `npm run demo`, which set `donna_demo` |
| `call ... has not ended yet` | `teach` called on an active call | Wait for the call to end |
| `v<N> has no recorded parent` on rollback | The active version was saved by a manager or the seed | Activate another version from the dashboard |
| First `npm run watch` makes many Gemini calls | It grades every old completed call that has no grade | Expected. Clear old test calls first if you want to avoid it |
| A rule the teacher added has disappeared | A manager removed the block or the line in the context editor | Expected. That edit is a new version; history still has the old one |
| `MONGODB_DB=donna_demo tsx ...` fails on Windows | The npm scripts use a Unix-style env prefix | Run on macOS/Linux, or set the variable separately |

## 10. Choices that differ from PLAN.md

- The teacher model is Gemini, not Claude. A Gemini key was the one available.
- Every call gets the full teaching pass, not only successful ones.
- The teacher never writes business facts or prices. PLAN.md auto-applied `context` and `data` changes; here a missing fact becomes a question for the owner.
- No eval gate. Protection against drift is the guardrails, the change log, and automatic rollback.
