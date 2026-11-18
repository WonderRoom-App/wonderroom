# M0: Migrations Test Build Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find out how WonderRoom changes the database at start, when the plugin list is known
only from the owner's config.

**Architecture:** A throwaway Payload app with no Next.js. Toy plugins build its config from a
plugin list. Each experiment changes the plugin list and records what the stock Payload
migration tools do. The output is a findings doc, not code to keep.

**Tech Stack:** Payload 3.85.0, `@payloadcms/db-postgres` 3.85.0, Postgres 16 (Docker), Node 24,
tsx.

**Spec:** `docs/specs/2026-11-18-wonderroom-design.md`, section "Migrations: a known risk".

## Global Constraints

- This is a test build. No tests, no polish. Code lives in `spikes/migrations/` on branch
  `spike/migrations`.
- Use stock Payload tools only (`payload migrate:create`, `payload migrate`, `prodMigrations`,
  `push`). Don't patch Payload.
- Use a throwaway database: `postgres://postgres:postgres@localhost:5432/wr_spike`, created and
  dropped by hand. Never point at a real site's database.
- Run every Payload CLI command with stdin from `/dev/null` and a time limit, because a
  container start has no one to answer a prompt. A command that waits on a prompt counts as
  **failed**, not "slow".
- Pin Payload and db-postgres to 3.85.0, the version DT runs.

## Questions this must answer

From the spec:

1. Can each plugin ship its own migrations, run in `requires` order, with table names taken
   from its slug? Or does the engine generate and apply the schema at start?
2. What happens to data when an owner removes a plugin?

Found while planning:

3. Polymorphic relationship tables have one column per target collection
   (`highlights_rels.typewriters_id`, `calculators_id`). Adding an item type changes other
   plugins' tables. Which approach handles that?
4. Drizzle asks "create or rename?" when a column disappears and another appears. What happens
   with no terminal: hang, error, or a silent default?

## Review Focus

- **A prompt with no terminal.** The expected behavior is a fast, clear error. A hang or a silent
  drop is a finding that rules an approach out.
- **Data in a table that the diff touches.** Every experiment inserts a row first and checks it
  afterwards.
- **A removed plugin.** The owner expects their data to stay. Any approach that drops tables
  without an explicit step is ruled out.
- **Two copies of one item type.** Table names must not collide.
- **Migration names across plugins.** Payload records migrations by name in
  `payload_migrations`. Two plugins with a migration of the same name must not clash.

---

### Task 1: Set up the test app

**Files:**
- Create: `spikes/migrations/package.json`, `spikes/migrations/payload.config.ts`,
  `spikes/migrations/plugins.ts`, `spikes/migrations/README.md`

**Interfaces:**
- Produces: `buildConfig(pluginList: string[])` in `payload.config.ts`, which reads the list from
  env `WR_PLUGINS` (comma separated, for example `typewriters,makers,featured`).
- Produces toy plugins in `plugins.ts`:
  - `itemType(slug: string)`: a collection with core fields `title` (text) and `yearFrom`
    (number), plus `ribbonSize` (text) for any slug that starts with `typewriters` or `office`.
  - `makers`: a `manufacturers` collection with `name`, and a `manufacturer` relationship field
    added to every item type.
  - `featured`: a `featured` collection with `machine`, a relationship whose `relationTo` is the
    list of loaded item type slugs, built from the registry.
- Migrations go to `migrationDir` set from env `WR_MIGRATIONS_DIR`, outside the app folder. This
  stands in for a volume in the container.

- [ ] **Step 1:** Create branch `spike/migrations`. Install `payload@3.85.0`,
  `@payloadcms/db-postgres@3.85.0`, `tsx`. Write the files above.
- [ ] **Step 2:** Create the database: `PGPASSWORD=postgres createdb -h localhost -U postgres wr_spike`
- [ ] **Step 3:** Check the app boots: with `WR_PLUGINS=typewriters,makers,featured`, run
  `payload migrate:create init < /dev/null`, then `payload migrate < /dev/null`.
  Expected: tables `typewriters`, `manufacturers`, `featured`, `featured_rels` exist (`\dt`).
- [ ] **Step 4:** Commit.

### Task 2: Generated migrations per install (approach B)

This tests the approach where the engine runs `migrate:create` then `migrate` at each start,
saving the migration files in the volume.

- [ ] **Step 1: Add a plugin.** Insert one typewriter and one featured row. Set
  `WR_PLUGINS=typewriters,coins,makers,featured`. Run `migrate:create` and `migrate`.
  Record: is there a prompt? Does `featured_rels` gain `coins_id`? Do the rows survive?
- [ ] **Step 2: Two copies.** Add `office-machines` (a second `itemType`). Record: separate
  tables? Any name collisions in enums, indexes or `_rels` columns?
- [ ] **Step 3: Rename a field.** Change `ribbonSize` to `ribbonWidth` in `itemType`. Run
  `migrate:create < /dev/null`. Record: hang, error or silent choice? If it picks "create", is
  the old column dropped with its data?
- [ ] **Step 4: Remove a plugin.** Drop `coins` from `WR_PLUGINS`. Run `migrate:create`.
  Record: does the migration drop the `coins` tables? Does it drop `featured_rels.coins_id`?
- [ ] **Step 5:** Commit the migration files the steps made, for the record.

### Task 3: Migrations shipped by each plugin (approach A)

This tests the approach where each plugin exports its own `up` functions and the engine
passes them to `prodMigrations` in `requires` order.

- [ ] **Step 1:** Fresh database. Write `up` functions by hand for `itemType(slug)` and
  `featured`, with SQL built from the slug. Name each migration `<plugin>:<slug>:<name>`. Pass
  them through `prodMigrations` with `NODE_ENV=production`.
  Record: do they run in order at start? Does Payload accept the names?
- [ ] **Step 2:** Add `coins`. Record who owns the new `featured_rels.coins_id` column: the
  `featured` plugin can't know about coins ahead of time. Write down what it would take, for
  example an engine-generated step for relationship columns only.
- [ ] **Step 3:** Commit.

### Task 4: Push at start (approach C)

- [ ] **Step 1:** Fresh database, `push: true`. Check whether Payload pushes at all with
  `NODE_ENV=production`. Read `@payloadcms/drizzle/dist/utilities/pushDevSchema.js` to confirm.
- [ ] **Step 2:** If it pushes, repeat Task 2 Steps 3 and 4 (rename, remove). Record the same
  things.
- [ ] **Step 3:** Commit.

### Task 5: Findings and spec update

**Files:**
- Create: `docs/spikes/2026-11-18-migrations-findings.md`
- Modify: `docs/specs/2026-11-18-wonderroom-design.md`, section "Migrations: a known risk"

- [ ] **Step 1:** Write the findings: a table of approach × experiment with what happened, then
  answers to questions 1–4.
- [ ] **Step 2:** Recommend one approach. Name what the engine must add around the stock tools,
  for example: refuse to start when a diff would drop a table or column, and show the owner the
  SQL; or a rename list a plugin ships with each version.
- [ ] **Step 3:** Replace the spec's "known risk" section with the chosen approach. Bring the
  recommendation to Joel before treating it as decided.
- [ ] **Step 4:** Drop the database: `PGPASSWORD=postgres dropdb -h localhost -U postgres wr_spike`.
- [ ] **Step 5:** Commit the findings and the spec change. Merge to `main` with `--no-ff`,
  keeping the test app's code in the branch history.
