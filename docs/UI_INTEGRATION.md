# Two dashboards, one API

Both dashboards are static pages in `web/` that read the same API (`docs/API.md`). Both keep the connection in the browser
(`?api=<url>` once, token in Settings), and both show "Connected" when the server is reachable.

| | Where | What it is for |
|---|---|---|
| **Ops dashboard** | `web/index.html` (served at `/`) | Operator view: live calls, customers, orders, messages, **Company Context** editor with rollback, and the **Improvements** tab: score timeline, **tool proposals with mockups** (approve, decline, how it works), the **scenario playbook**, the teacher's change log and the **owner answer box** |
| **Snoopy dashboard** | `web/snoopy/index.html` (served at `/snoopy/`) | The redesigned owner-facing UI from the `snoopy-ui` / `snoopy-mongodb-theme` branches: Line, Calls, Learning, Knowledge, Customers (with editing), Orders, Messages |

## What was changed to make the Snoopy dashboard work with the real teacher

It was built against a mock data shape; with real teacher data its Learning view crashed. Fixes (all in this repo):

1. **Crash:** `byV[cur].length` threw when the active Knowledge version had no graded calls yet (always true right after the
   teacher makes a change). It is now `(byV[cur] || []).length`.
2. **Data shape:** the page now asks for `GET /api/grades?shape=ui` and `GET /api/improvements?shape=ui`. The server converts the
   teacher's documents to what the page reads (`src/routes/uiShape.ts`): grade `overall` 0-10 to `score` 0-100, `config_version_id`
   `"v2"` to `configVersion` 2, scores to 1-5 dimensions, `payload` to `title` / `change`, evidence turn to the quote from the call,
   `applied_in_config_id` to `toVersion` / `fromVersion`. Without `?shape=ui` the raw documents are returned.
3. **Actions:** `POST /api/improvements/:id` with `{ action: "approve" | "dismiss" | "rolled_back" }`: approving a tool enables it,
   dismissing declines it; approving or dismissing a playbook entry turns it on or off. A rule the teacher already applied cannot be
   dismissed (undo it by restoring the previous Knowledge version, which the page's Undo button does).
4. **Owner questions:** the "Answer" button on a question opens a prompt and saves through `POST /api/improvements/:id/answer`.
5. Cards for tools and edge cases (not tied to a Knowledge version) say "Live now" instead of "Live in v".

`PUT /api/customers/:phone` (owner edit of a customer, from the Snoopy branch) is included.

## Keeping them in sync

The Snoopy page was copied from branch `snoopy-mongodb-theme` at commit `75932da`. Further edits to that UI should be made in
`web/snoopy/index.html` on this branch (or copied over), otherwise they will not appear here. The two compatibility edits
(crash fix and `?shape=ui`) are the only differences from the branch copy, plus the badge wording and the owner-answer prompt.
