# Migrations test build: findings

Date: 2026-11-18. Plan: `docs/plans/2026-11-18-m0-migrations-spike.md`. Code and the
generated migrations: `spikes/migrations/` on branch `spike/migrations`.

Setup: Payload 3.85.0 and `@payloadcms/db-postgres` 3.85.0 (DT's versions), Postgres 16, no
Next.js. Every CLI run had stdin from `/dev/null` and a 120-second limit, like a container
start. Each experiment put a row in the tables first and checked it afterwards.

## What happened

| Experiment | B: generate per install (`migrate:create` + `migrate`) | A: each plugin ships migrations (`prodMigrations`) | C: push at start (`push`) |
|---|---|---|---|
| Add an item type (Coins) | Works. No prompt. Adds `coins_id` to `featured_rels` and `payload_locked_documents_rels`. Rows kept. | Coins tables work. **Linking a coin from Featured fails**: `featured_rels.coins_id` does not exist, and no plugin owns it. The failure shows only when someone uses it, not at start. | Works. |
| Two copies of one type | Works. Separate tables, indexes and `_rels` columns. Payload prefixes enums with the slug (`enum_calculators_status` in DT), so they don't collide either. | Not tried; same cross-plugin problem as above. | Not tried. |
| Rename a field | **Silent failure.** Drizzle shows "create or rename?", stdin closes, the command exits **0** and writes **no** migration. A start script would think it worked. | The plugin author writes the rename by hand. Works, but see the general cost below. | **Hangs** on the same prompt (timed out). |
| Rename, with the engine's help | Works. A hand-written `RENAME COLUMN` migration plus the previous snapshot edited to the new name: no prompt, data kept, and the next diff is empty. | — | — |
| Remove a plugin | **Silent data loss.** Writes `DROP TABLE "coins" CASCADE` and drops the `coins_id` columns, no warning, exit 0. (Not applied.) | Nothing happens; tables stay. | **Hangs** on "You're about to delete coins table with 1 items. Accept? (y/N)". Data kept. |

Other facts:

- `migrate:create` diffs the **latest snapshot file** (`<name>.json`, saved next to each
  migration) against the current config. It never reads the live database
  (`@payloadcms/drizzle/dist/utilities/buildCreateMigration.js`).
- `migrate` reads the migration files from the folder, not from `index.ts`, so the engine can
  add a file of its own.
- `prodMigrations` runs at start when `NODE_ENV=production`, in array order. Payload accepts
  names like `item-type:coins:create`.
- Push runs only when `NODE_ENV` is not `production` (`db-postgres/dist/connect.js:110`).
- `payload_locked_documents_rels` gets one column for **every** collection. So every plugin
  that adds a collection changes an engine table too.
- `migrate:create` does not create a missing migrations folder.

## Answers to the plan's questions

1. **Can each plugin ship its own migrations?** Not on its own. Polymorphic relationship
   tables (`featured_rels`) and Payload's `payload_locked_documents_rels` get a column for
   every collection. A plugin can't know which other plugins an owner will load. Plugin authors
   would also need to hand-write SQL that matches Payload's internal schema exactly. **The
   engine has to generate the schema for each install.**
2. **What happens to data when an owner removes a plugin?** With stock generate, the tables
   are dropped silently. With push, start hangs. Neither is acceptable as is. The engine must
   stop and ask.
3. **Who owns cross-plugin columns?** Only a diff of the whole config can. That rules out A.
4. **What does Drizzle do without a terminal?** `migrate:create` exits 0 and writes nothing.
   Push hangs. Neither is a clear error.

## Recommendation: B, inside an engine guard

Generate migrations per install with the stock `migrate:create` and `migrate`. Keep the
migration files and snapshots in a volume. Wrap them in a guard the engine owns:

1. **Find ambiguity before Drizzle does.** Compare the latest snapshot with the new config. In
   any table where a column disappears and another appears (or a table disappears and another
   appears), there is a prompt coming. If a plugin declared that rename, apply it (next point).
   If not, refuse to start, and name the table and columns.
2. **Renames a plugin declares.** A plugin version ships a rename list, for example
   `{ field: 'ribbonSize', to: 'ribbonWidth', since: '1.3.0' }`. The engine writes the
   `RENAME COLUMN` migration for every copy of that item type and edits the snapshot. This is
   tested above.
3. **Never drop without the owner's word.** Scan the generated SQL for `DROP TABLE` and
   `DROP COLUMN`. If any appear, don't apply. Refuse to start and show the SQL, with two
   choices: put the plugin back, or confirm the removal in `plugins.yml` (for example
   `removed: [coins]`). Before applying a confirmed drop, make a `pg_dump`.
4. **Check that a migration was written** whenever the guard expected a diff, so a silent exit
   0 can never pass.

What this costs: the guard reads and edits Payload's snapshot files. That format belongs to
Drizzle, not to a public Payload API, so a Payload upgrade could change it. Pin Payload, and
keep these experiments as tests of the guard that run on every upgrade.

Open for M1 (builder's call):

- Losing the migrations volume while keeping the database would make the next diff start from
  nothing. Either back the folder up with the database, or keep the latest snapshot in a
  database table as well.
- DT's 52 existing migrations stay behind in the DT repo. DT's install starts with a fresh
  snapshot of its current schema. The one-way data reshape is M7's job.
