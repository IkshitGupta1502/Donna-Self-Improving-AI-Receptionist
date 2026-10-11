# RSI harness: teacher output -> voice agent update

The grading model (owned by someone else) only has to implement `Teacher` (`src/services/harness/teacher.ts`)
and return JSON matching `TeacherReportSchema` (`types.ts`). Everything after that is the harness.

```
call ends -> recorder.end() -> processCall(call)
  1. classifyOutcome(call)            deterministic success from the tool trace (outcome.ts)
  2. teacher.grade(input)             full pass if success, failure_analysis otherwise
  3. validate report                  bad improvements are dropped individually (grade.dropped)
  4. save grade                       scores, overall, frustration, outcome, config version used
  5. route each improvement           policy.ts -> applied | proposed (with reason) | rejected (duplicate)
  6. apply                            prompt/context -> new immutable config version, pointer moved
                                      data -> DataStore write; inverse stored in improvement.undo
next call: liveSession loads the active config, tags the call with its versionId
```

## What the teacher can change (`payload`)
| type | ops | applied by default |
|---|---|---|
| prompt | `add_rule`, `remove_rule` (a "LEARNED RULES" list appended to the immutable base prompt) | yes |
| context | `upsert_doc`, `remove_doc` ("SHOP KNOWLEDGE" docs in the prompt) | yes |
| data | `upsert_price`; `remove_price` needs approval | yes |
| tool, schema | proposal only, shown in the dashboard | never |

Each improvement carries `title`, `rationale`, `evidenceTurns`, `confidence`, `payload`.

## Guardrails (`policy.ts`, not editable by the teacher)
Hard (also bind human approval): size limits, max 15 rules / 20 docs, forbidden text (prompt-injection phrases, URLs,
refunds/discounts), price sanity. Soft (only gate auto-apply, a human can override): confidence >= 0.6,
10 auto-applied changes per day, price changes over 50%, `HARNESS_AUTO_APPLY=false` turns auto-apply off.

## Storage
`config_versions` (immutable, `parentId` chain), `harness_state` (active pointer), `grades`, `improvements`.
In-memory when `MONGODB_URI` is unset.

## Rollback
- `POST /api/harness/improvements/:id/rollback` applies the stored inverse (a new `rollback` version, or a data revert).
- `POST /api/harness/versions/:id/activate` is the pointer-only rollback.

## API (all under `/api`, same token/CORS as the rest)
`GET harness/state | versions | grades | improvements?status=`,
`POST harness/improvements/:id/approve | reject | rollback`, `POST harness/versions/:id/activate`,
`POST harness/calls/:callSid/regrade`.

## Plugging in the real teacher
```ts
import { setTeacher } from "./services/harness/teacher";
setTeacher({ name: "claude-sonnet-5-5", grade: async (input) => /* call Claude, return parsed JSON */ });
```
Not done yet: call `setTeacher` at startup in `server.ts` once the real teacher exists, and the dashboard Improvements tab.
`npm run harness:demo` runs the loop offline with `mockTeacher`.
