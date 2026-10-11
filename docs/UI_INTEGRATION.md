# Connecting the `snoopy-ui` / `snoopy-mongodb-theme` dashboard to the real server

Checked 2026-10-11 by running the UI from branch `snoopy-mongodb-theme` in a browser against the real bridge
(`npm run dev`) backed by a MongoDB-compatible database that the real teacher had written into.

**What works:** all seven views (Line, Calls, Learning, Knowledge, Customers, Orders, Messages) load, every API call
returns 2xx, the nav and branding ("CJ's Cleaning") show, Calls / Orders / Customers / Messages / Knowledge render real data.

**What does not: the Learning view.** It was built against a mock data shape that the real teacher does not write.
With real data it crashes and, once the crash is fixed, shows `null average quality on Knowledge vNaN across 0 calls`
and empty cards.

## 1. Crash (one word)

`renderLearning`, line ~1278: `byV[cur].length` throws when the active Knowledge version has no graded calls yet.
That is always true right after the teacher creates a new version (the call was graded under v1, the active version is v3).
Fix: `(byV[cur] || []).length`. Check `byV[...]` lookups elsewhere the same way.

## 2. Grades: field mapping (`GET /api/grades`)

| The UI reads | Real field | Conversion |
|---|---|---|
| `callSid` | `call_id` | rename |
| `configVersion` (number) | `config_version_id` (`"v2"` or `null`) | `Number(id.slice(1))` |
| `score` (0 to 100) | `overall` (0 to 10) | `Math.round(overall * 10)` |
| `frustration` (0 to 1) | `frustration` (0 to 10) | `/ 10` |
| `dims.accuracy / tools / completion / tone / brevity` (1 to 5) | `scores.accuracy / tool_use / task_completion / tone / brevity` (0 to 10) | `Math.max(1, Math.round(x / 2))` |
| `summary` | `rationale` | rename |
| `createdAt` | `created_at` | rename |
| `outcome` | `outcome` | same values: `answered`, `message_taken`, `failed` |

## 3. Improvements: field mapping (`GET /api/improvements`)

| The UI reads | Real field | Conversion |
|---|---|---|
| `id` | `_id` | rename |
| `type` | `type` | same: `prompt`, `context`, `tool`, `schema` |
| `status` | `status` | real values: `applied`, `proposed`, `rejected`, `rolled_back`. Map `rejected` to the UI's `dismissed` |
| `title` | none | `prompt`: `payload.text` cut to ~70 chars; `context`: `payload.question`; `tool`: `"New tool: " + payload.tool_name` |
| `rationale` | `reason` | rename |
| `change` | `payload.text` (prompt, tool) or `payload.question` (context) | pick |
| `evidence: [{callSid, quote}]` | `source_call_ids[0]` and `evidence_turns` | quote = text of turn `evidence_turns[0]` in `GET /api/calls/:callSid` (turn n = transcript index n-1) |
| `toVersion` | `applied_in_config_id` (`"v2"`) | `Number(id.slice(1))` |
| `fromVersion` | none | `toVersion - 1`, or the version's `parentVersion` from `GET /api/config` |
| `createdAt` | `created_at` | rename |

## 4. Behaviour differences to design for

- **Tools are built automatically.** The UI says approving a tool "needs building before it goes live". In the real system the
  teacher writes a declarative tool (with a recipe and a mockup) and, when the call scored below `TOOL_GRADE_THRESHOLD` (7),
  enables it itself (`enabledBy: "teacher"`). Otherwise it waits: `POST /api/tools/:name/enable` (or `/disable`, `/decline`).
  `GET /api/tools` returns the proposals, including `mockup`, `recipe`, `recipeVerified`, `enabledBy`, `requestCount`.
- **Context items are questions for the owner, not text to approve.** The UI's "Approve" for a `context` item applies
  `change` to the knowledge. In the real system the teacher asks a question (at most 2 per call) and the owner answers:
  `POST /api/improvements/:id/answer` with `{ "answer": "..." }` (MongoDB only). The answer is appended to the knowledge as
  `Owner answer: <question> <answer>`, as a new version authored by the manager.
- **`POST /api/improvements/:id` with `{ action }` does not exist.** Use the endpoints above. Undo of a rule change is
  `POST /api/config/activate { version }`, which already works.
- **Prompt changes** (`type: "prompt"`) are applied by the teacher by itself (a learned rule in the knowledge text); the
  owner undoes them by re-activating the previous version.

## 5. Endpoints the UI does not call yet

`GET /api/tools`, `GET /api/records`, `GET /api/appointments`, `GET /api/stats`, and the writes above. Full list in `docs/API.md`.
The bundled dashboard (`web/index.html`, Improvements tab) already shows tools with mockups, "how it works", the owner answer
box and the score timeline against this same data; it can be used as a reference implementation.

## 6. A faster way

If it is easier to keep the UI's shapes, the bridge can return them: add `?shape=ui` to `GET /api/grades` and
`GET /api/improvements` and convert with the tables above on the server. Say so and it is a small change.
