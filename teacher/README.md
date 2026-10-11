# Donna teacher agent

Grades every finished receptionist call and rewrites the receptionist's harness (rules) in MongoDB Atlas.
Built during the Harness Engineering & Model Wrangling hackathon, 2026-10-11.
Team status, data shapes for the dashboard, and known issues: [../docs/TEAM_HANDOFF.md](../docs/TEAM_HANDOFF.md).

## Run
```
cd teacher && npm install
# create .env (see below), never commit it
npm run selftest          # offline, no keys needed
npm run demo              # seeds the donna_demo database, teaches 3 fake calls, prints the new context
```
`.env` in this `teacher/` folder:
```
MONGODB_URI=mongodb+srv://USER:PASSWORD@YOUR-SANDBOX-CLUSTER.mongodb.net
MONGODB_DB=snoopy
GEMINI_API_KEY=
GEMINI_TEACHER_MODEL=gemini-3.8-flash
```

Other commands: `npm run teach <callId>`, `npm run answer <improvementId> <answer>`,
`npm run rollback`, `npm run trend`, `npm run tools` (list tool proposals), `npm run playbook` (list playbook entries), `npm run context`, `npm run watch`.

## Running with the voice bridge
No code change is needed in the bridge (the repo root). Point both at the same
Atlas database (`MONGODB_URI`, `MONGODB_DB`), start the bridge as usual, and run the teacher next to it:
```
npm run watch
```
It grades every finished call that has no grade yet and writes new config versions in the bridge's own format
(author `teacher`), so they show up in the bridge's dashboard history and are loaded on the next call.
The teacher keeps its rules in a `LEARNED RULES` block at the end of the config's context text.

`npm run demo` and `npm run seed` only ever touch the separate database `donna_demo`.

## Safety limits (src/services/teacher/plan.ts)
- The rubric lives in code; the teacher cannot edit it. Overall score is computed in code.
- Every issue needs an exact transcript quote; every change needs evidence turns.
- The teacher changes behavior rules only. It can never change the company's own text: missing facts become owner questions.
- A rule containing a number that is not already in the config is rejected.
- At most 3 rule changes per call, 20 rules total, locked rules cannot be touched.
- Config versions are immutable; rollback is one pointer change.

## Tool proposals (capability gaps)
When a call proves a gap (the caller made a clear request, no tool covered it, the agent said it cannot, deflected, or only took a message), the judge adds one optional `tool_proposal` with a mockup
(sample dialogue, example args, example result). `plan.ts` validates it in code (snake_case name 3-40 chars and not a built-in; max 6 params of type string/number/boolean with descriptions under 200 chars;
description under 300; 2 to 8 dialogue turns with roles caller/agent/tool; exampleArgs keys must be params; every evidence quote must be in the transcript; no URLs, credentials, payments or card numbers).
A rejected proposal is stored as an `improvements` document (type `tool`, status `rejected`, `rejected_reason`).

An accepted one goes into the collection `tool_proposals` (`_id` = tool name; shape `ToolProposal` in `src/services/mongo/types.ts`) and an `improvements` document (type `tool`, `payload.tool_name`).
Tools are declarative: the bridge saves the args as a record (write) or lists that caller's records (read).
- New tool: inserted. Repeat request: `requestCount` + 1, `sourceCallSids` unioned, status kept. Status `disabled` or `declined` (owner decision): never touched or reopened.
- Auto-enable (default ON): if `TEACHER_AUTO_ENABLE_TOOLS` is not `0` and the call's overall grade is below `TOOL_GRADE_THRESHOLD` (default `7`), the tool is stored as `enabled` with `enabledAt` and `enabledBy: "teacher"`
  (a still-`proposed` tool is promoted the same way). Otherwise it is `proposed` and the owner enables it from the dashboard. The `improvements.reason` says which happened.
- `npm run tools` lists proposals (name, status, requestCount, why). `npm run demo` includes a dry cleaner call (`fake_call_4`) that should produce a proposal (needs `GEMINI_API_KEY`).

## Tool recipes (tools that really do something)
A `tool_proposal` may carry a `recipe`: JSON in the safe recipe language (`src/services/teacher/recipe.ts`: expressions, `compute` / `require` / `save` / `lookup` / `call` steps, a `response` map; no code is run).
Use it for calculations (price quote with a rush fee), rules and limits (damage claim up to a limit) and the calendar/rush features (`call` the built-ins `get_order`, `lookup_price`, `quote_turnaround`, `schedule_appointment`, `set_order_type`, `create_order`).
`plan.ts` checks it in code: `validateRecipe`, then every data-changing call (`schedule_appointment`, `set_order_type`, `create_order`) needs a boolean param `confirmed` passed through (`{"ref":"confirmed"}`) in its args,
then a self-check (`selfCheckRecipe`) runs the recipe on the proposal's own `exampleArgs` against a mock io and must succeed. A passing proposal is stored with `recipe` and `recipeVerified: true`; a failing one is rejected with the reason.
`printResult` lists whether a recipe exists, `recipeVerified`, and one plain-English line per step (`describeRecipe`).
`recipe.ts` is a synced copy of `../src/services/tools/recipe.ts` (shared with the bridge): never edit one copy alone.

## Owner questions
When the receptionist lacked business knowledge (pricing, hours/scheduling, delivery area, policies), the judge asks the owner at most 2 short questions per call (`context` improvements, status `proposed`).
`plan.ts` enforces max 2 per call, under 160 characters, and rejects a question that repeats one already open or answered (same text after normalisation, or word overlap above 0.8; `buildPlan` takes the existing questions as `extra.existingQuestions`).
The owner's answer is appended to the company text as `Owner answer: <question> <answer>` by `answerOwnerQuestion`.

## Scenario playbook (edge cases)
After a call the judge may add one optional `playbook_entry`: a specific, repeatable situation the receptionist met or fumbled and how to handle it next time ("when this happens, do this").
It is not a rule (always-on principle), not a tool (capability) and not an owner question (missing fact). The bridge puts every `active` entry in the receptionist's prompt; the owner can add entries and change status from the dashboard.
Collection `playbook` (`_id` = `id` = `PB-` + 6 digits; shape `PlaybookEntry` in `src/services/mongo/types.ts`): title (80), when (200), handling (300), source `teacher|owner`, status `active|proposed|disabled`, timesSeen, sourceCallSids, evidence, createdAt, updatedAt.
- `validatePlaybookEntry` (plan.ts): limits, every evidence quote must be in the transcript, no URLs/credentials/payments (same list as tools), no number or amount in `handling` that is not in the business knowledge (same guard as rules, whole numbers only), nothing the receptionist cannot do (email, text message, transfer). Rejections are stored as an `improvements` document with `rejected_reason`.
- `decidePlaybookStatus`: new entry is `active` when the call's overall grade is below `PLAYBOOK_GRADE_THRESHOLD` (default `7`) and `PLAYBOOK_AUTO_ACTIVATE` is not `0` (default ON), else `proposed` for the owner. A similar existing entry of any status (same normalised title, or word overlap above 0.7 on title + when) is only bumped (`timesSeen` once per call, sources unioned, `updatedAt`); the teacher never changes the status of an existing entry and never reactivates a `disabled` one.
- Each outcome also adds an `improvements` document (type `prompt`, `payload { text: "When <when>: <handling>", playbook_id }`, no `op`, no `rule_id`, no `applied_in_config_id`): status `applied` (created active, or seen again while active), `proposed`, or `rejected`. It never creates a config version or changes the learned rules.
- `npm run playbook` lists entries. `npm run demo` includes `fake_call_6` (hold an order until next Tuesday; the agent only takes a message), which should produce an entry (needs `GEMINI_API_KEY`).
