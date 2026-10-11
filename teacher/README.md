# Snoopy teacher agent

Grades every finished receptionist call and rewrites the receptionist's harness (rules) in MongoDB Atlas.
Built during the Harness Engineering & Model Wrangling hackathon, 2026-10-11.
Team status, data shapes for the dashboard, and known issues: [../docs/TEAM_HANDOFF.md](../docs/TEAM_HANDOFF.md).

## Run
```
cd teacher && npm install
# create .env (see below), never commit it
npm run selftest          # offline, no keys needed
npm run demo              # seeds the snoopy_demo database, teaches 3 fake calls, prints the new context
```
`.env` in this `teacher/` folder:
```
MONGODB_URI=mongodb+srv://USER:PASSWORD@YOUR-SANDBOX-CLUSTER.mongodb.net
MONGODB_DB=snoopy
GEMINI_API_KEY=
GEMINI_TEACHER_MODEL=gemini-3.8-flash
# Google Calendar for the voice agent's booking tools (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_CALENDAR_ID=
```
The free Gemini tier allows 20 requests per day per model, and each graded call is one request.

Other commands: `npm run teach <callId>`, `npm run answer <improvementId> <answer>`,
`npm run rollback`, `npm run trend`, `npm run context`, `npm run watch`.

## Running with the voice bridge
No code change is needed in the bridge (the repo root). Point both at the same
Atlas database (`MONGODB_URI`, `MONGODB_DB`), start the bridge as usual, and run the teacher next to it:
```
npm run watch
```
It grades every finished call that has no grade yet and writes new config versions in the bridge's own format
(author `teacher`), so they show up in the bridge's dashboard history and are loaded on the next call.
The teacher keeps its rules in a `LEARNED RULES` block at the end of the config's context text.

`npm run demo` and `npm run seed` only ever touch the separate database `snoopy_demo`.

## Calendar tools for the voice agent
`src/services/integrations/gateway.ts` gives the voice agent two tools, `check_availability` and `book_appointment`,
behind a permission that only the teacher and the owner can change: `disabled`, `requires_approval` or `auto`.
The teacher never calls the calendar. It lowers a permission after a bad booking and can raise it one level after
3 calls with clean use.
```
npm run calendar:check                       # live test: reads free/busy, creates a test event
npm run calendar:setup "Maya" <calendar id>  # add a staff member
npm run permission book_appointment requires_approval
npm run appointments                         # list bookings
npm run approve <appointment id>             # owner approves a queued booking (creates the event)
npm run reject <appointment id>
```

## Safety limits (src/services/teacher/plan.ts)
- The rubric lives in code; the teacher cannot edit it. Overall score is computed in code.
- Every issue needs an exact transcript quote; every change needs evidence turns.
- The teacher changes behavior rules only. It can never change the company's own text: missing facts become owner questions.
- A rule containing a number that is not already in the config is rejected.
- At most 3 rule changes per call, 20 rules total, locked rules cannot be touched.
- Config versions are immutable; rollback is one pointer change.
