# M1 Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An engine that reads `plugins.yml`, builds a Payload config from first-party plugins,
migrates the database safely at start, and serves the admin. A toy item type listed in
`plugins.yml` gets its tables at start and appears in the admin.

**Architecture:** npm workspaces. `packages/core` (`@wonderroom/core`) holds the plugin API,
the install loader, the config builder, the items index and the migration guard.
`packages/plugin-curios` is the toy item type. `app/` is the stock Payload blank template,
whose `payload.config.ts` calls the core's `buildEngineConfig`. Packages ship TypeScript
source; Next.js transpiles them and the Payload CLI loads them through its own loader.

**Tech Stack:** Payload 3.94.0, `@payloadcms/db-postgres` 3.94.0, Next.js 16.4.6, React 19.2.9,
Postgres 16, Node 24, vitest (unit and DB tests) and Playwright (one end-to-end test), both
from the blank template. `yaml` for config files.

**Spec:** `docs/specs/2026-11-18-wonderroom-design.md`. Evidence for the guard:
`docs/spikes/2026-11-18-migrations-findings.md` and
`docs/spikes/2026-11-18-item-reference-findings.md`. Roadmap row M1:
`docs/plans/2026-11-18-roadmap.md`.

## Global Constraints

- Branch `m1/engine-core`. Merge to `main` with `--no-ff` after the final review, with Joel's OK.
- Pin exact versions: `payload`, every `@payloadcms/*` at `3.94.0`; `next` `16.4.6`; `react`
  and `react-dom` `19.2.9`. No `^` on these. (Planning ruling: the stock scaffolder
  `create-payload-app@3.85.0 -t blank` installs 3.94.0 today. The project is greenfield, so
  take the current version; Task 7's guard tests repeat the M0 experiments on it.)
- Stock tools only: the blank template, `payload migrate:create`, `payload migrate`,
  `payload run`. No `patch-package` patches in M1.
- **No literal item type slugs** in `packages/core`. The engine learns item types from the
  plugins it loads.
- No plugin uses Payload's polymorphic `relationTo: [...]`. "Any item" references use the
  engine's `itemReference` field (Task 5).
- Every message that stops the start names the file or table involved and says what the owner
  can do. Plain English: one idea per sentence, active voice.
- Environment: `DATABASE_URL`, `PAYLOAD_SECRET`, `WONDERROOM_CONFIG_DIR` (default
  `../config` from `app/`), `WONDERROOM_DATA_DIR` (default `../data`; holds `migrations/` and
  `backups/`), `WONDERROOM_STEP_TIMEOUT_MS` (default `300000`).
- The migrate step always runs with `NODE_ENV=production`, so Payload never pushes the schema.
- Dev and test database: `postgres://postgres:postgres@localhost:5433/postgres` from the root
  `compose.dev.yml`. DB tests create a database with a random name and drop it afterwards.
  Never point a test at a database it didn't create.

## Review Focus

1. **A malformed `plugins.yml`** (bad YAML, `plugins` not a list, an entry without `use`). The
   owner expects a message with the file name and the problem, not a stack trace. Task 3 tests.
2. **A plugin field whose name matches a core field** (`title`) or another plugin's field on the
   same item type. The owner expects the start to stop and name both plugins. Task 4 tests.
3. **A stale confirmation.** An owner confirms "drop table coins", later adds Coins back, then
   removes it again. The old line in `plugins.yml` must not approve the second drop. Task 6
   tests (keys carry the migration name they were issued against).
4. **A start that dies halfway** (the container is stopped after `migrate:create` wrote files
   but before `migrate` applied them). The next start must not trust those files. Task 7 tests
   (unapplied generated files are deleted before analysis).
5. **Bulk delete in the admin** of items that something references. The delete rules must run
   for every item, as for a single delete. Task 5 tests.

---

### Task 1: Workspace, app scaffold and dev database

**Files:**
- Create: `package.json` (root), `compose.dev.yml`, `packages/core/package.json`,
  `packages/core/src/index.ts`, `packages/core/vitest.config.ts`,
  `packages/core/test/smoke.test.ts`
- Create (scaffolder): `app/` from the blank template
- Modify: `.gitignore`, `app/package.json`, `app/next.config.ts`
- Delete: `app/docker-compose.yml`, `app/Dockerfile`, `app/.yarnrc`, `app/vitest.config.mts`,
  `app/tests/int/` (M6 writes the real image files; core tests live in the packages)

**Interfaces:**
- Produces: workspace names `@wonderroom/core`, `app`; root scripts `test` (vitest in every
  package), `dev` (`npm run dev -w app`), `db:up` (`docker compose -f compose.dev.yml up -d`).
  `packages/core/package.json` has `"type": "module"` and
  `"exports": { ".": "./src/index.ts" }`.

- [ ] **Step 1:** From the repo root run
  `npx create-payload-app@3.85.0 -n app -t blank --db postgres --db-connection-string postgres://postgres:postgres@localhost:5433/postgres --use-npm --no-deps --no-agent --no-git`.
  Expected: `app/src/app/(payload)/admin/[[...segments]]/page.tsx` exists and
  `app/package.json` pins `payload` `3.94.0`.
- [ ] **Step 2:** Write the root `package.json` with `"workspaces": ["app", "packages/*"]`,
  the scripts above, and `"engines": { "node": ">=24" }`. Move the template's `.npmrc` to the
  root. Delete the files listed above. Add `data/` and `app/.env` to `.gitignore`.
- [ ] **Step 3:** Write `compose.dev.yml`: one `postgres:16` service, password `postgres`, port
  `5433:5432`, a named volume.
- [ ] **Step 4:** Write `packages/core/test/smoke.test.ts`: `import * as core from '../src'`
  and assert `typeof core === 'object'`. Run `npm install`, then `npm test`.
  Expected: 1 test passes.
- [ ] **Step 5:** Add `transpilePackages: ['@wonderroom/core']` to `app/next.config.ts` and
  `"@wonderroom/core": "*"` to `app/package.json`. Run `npm run db:up` and `npm run build -w app`.
  Expected: build succeeds.
- [ ] **Step 6:** Commit: `chore: npm workspaces, blank Payload app, dev database`.

### Task 2: The plugin shape and load order

**Files:**
- Create: `packages/core/src/plugin.ts`, `packages/core/src/order.ts`
- Test: `packages/core/test/plugin.test.ts`, `packages/core/test/order.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type PluginKind = 'item-type' | 'add-on' | 'integration' | 'theme'
  type ItemTypeDefinition = {
    slug: string
    labels: { singular: string; plural: string }
    fields: Field[]                 // Payload fields, added after the core fields
  }
  type WonderRoomPlugin = {
    name: string                    // matches the `use:` name in plugins.yml
    kind: PluginKind
    requires?: string[]             // plugin names
    itemType?: ItemTypeDefinition   // required when kind is 'item-type', forbidden otherwise
    collections?: CollectionConfig[]
  }
  type PluginFactory = (settings: Record<string, unknown>) => WonderRoomPlugin
  function definePlugin(plugin: WonderRoomPlugin): WonderRoomPlugin
  class StartError extends Error {}  // every owner-facing stop throws this
  function orderPlugins(plugins: WonderRoomPlugin[]): WonderRoomPlugin[]
  ```

- [ ] **Step 1: Write the failing tests.**
  - `definePlugin` throws `StartError` for: an empty name; an unknown kind; `kind: 'item-type'`
    without `itemType`; `itemType` on any other kind. It returns the plugin unchanged otherwise.
  - `orderPlugins` puts each plugin after everything it requires and otherwise keeps the
    input order: input `[twdb(requires typewriters, makers), typewriters(requires makers),
    makers]` → names `['makers', 'typewriters', 'twdb']`.
  - A missing requirement throws `StartError` with message
    `twdb requires makers, but plugins.yml does not list makers.`
  - A loop throws `StartError` with message `These plugins require each other in a loop: a → b → a.`
  - A duplicate name throws `StartError`: `plugins.yml lists curios twice.`
- [ ] **Step 2:** Run `npm test -w @wonderroom/core`. Expected: the new tests fail.
- [ ] **Step 3:** Implement `plugin.ts` and `order.ts` (depth-first topological sort that
  visits plugins in input order; the path stack gives the loop message). Export from `index.ts`.
- [ ] **Step 4:** Run the tests. Expected: pass.
- [ ] **Step 5:** Commit: `feat(core): plugin shape and requires ordering`.

### Task 3: Reading the install's config folder

**Files:**
- Create: `packages/core/src/install.ts`
- Test: `packages/core/test/install.test.ts` (each test writes a temp config folder)

**Interfaces:**
- Consumes: `PluginFactory`, `StartError`, `orderPlugins` (Task 2).
- Produces:
  ```ts
  type Catalog = Record<string, PluginFactory>
  type Install = {
    site: { name: string }                 // from config.d/site.yml; default 'WonderRoom'
    plugins: WonderRoomPlugin[]            // built and ordered
    confirm: string[]                      // plugins.yml `confirm:` lines, as written
  }
  function loadInstall(configDir: string, catalog: Catalog): Install
  ```
  `plugins.yml` shape: `plugins:` list of entries `{ use: string, ...settings }`, and an
  optional `confirm:` list of strings. A plugin's settings are `config.d/<use>.yml` (if it
  exists) merged under the entry's own keys (the entry wins).

- [ ] **Step 1: Write the failing tests.**
  - A folder with `plugins: [{use: curios, slug: oddities}]` and `config.d/curios.yml`
    holding `label: Oddities` calls the `curios` factory with
    `{ slug: 'oddities', label: 'Oddities' }`.
  - `config.d/site.yml` `name: Parlor` gives `site.name === 'Parlor'`.
  - `StartError` messages, one test each:
    - no `plugins.yml`: `No plugins.yml in <dir>. Create one that lists your plugins.`
    - invalid YAML: message starts `plugins.yml line <n>:` (from the `yaml` parser's position)
    - `plugins` not a list: `plugins.yml: "plugins" must be a list.`
    - an entry without `use`: `plugins.yml entry 2 has no "use".`
    - an unknown name: `plugins.yml lists "coinz", which is not a known plugin. Known plugins: curios.`
    - an entry with `from:`: `plugins.yml entry 1 uses "from". Plugins from npm or git come in a later version.`
  - `confirm:` lines pass through unchanged.
- [ ] **Step 2:** Run the tests. Expected: fail.
- [ ] **Step 3:** Add `yaml` to `packages/core`. Implement `loadInstall`; it ends with
  `orderPlugins`.
- [ ] **Step 4:** Run the tests. Expected: pass.
- [ ] **Step 5:** Commit: `feat(core): read plugins.yml and config.d`.

### Task 4: Building the Payload config, core fields and the toy plugin

**Files:**
- Create: `packages/core/src/config.ts`, `packages/core/src/coreFields.ts`,
  `packages/core/src/collections/{Users,Media,Tags}.ts`
- Create: `packages/plugin-curios/package.json`, `packages/plugin-curios/src/index.ts`
- Create: `app/src/catalog.ts`; Modify: `app/src/payload.config.ts`; Delete: `app/src/collections/`
- Create: `config/plugins.yml` (lists `curios`)
- Test: `packages/core/test/config.test.ts`

**Interfaces:**
- Consumes: `Install`, `loadInstall`, `Catalog` (Task 3).
- Produces:
  ```ts
  function buildEngineConfig(options: {
    catalog: Catalog
    configDir: string
    dataDir: string
    databaseUrl: string
    secret: string
  }): Promise<SanitizedConfig>            // returns Payload's buildConfig(...)
  function itemTypeSlugs(config: SanitizedConfig): string[]   // from custom.wonderroom
  const coreItemFields: Field[]
  ```
  The built config stores `custom.wonderroom = { itemTypes: string[], confirm: string[] }`.
  The database adapter gets `migrationDir: <dataDir>/migrations` and `push: false`.
  `@wonderroom/plugin-curios` default-exports a `PluginFactory`: settings `slug` (default
  `curios`), `label` (default `Curio`/`Curios`); fields `material` (text) and `acquiredFrom`
  (text).

- [ ] **Step 1: Write the failing tests** (build the config in memory; no database).
  - Collection order: every item type first, in `plugins.yml` order, then `users`, `media`,
    `tags`, then add-on collections. (Spec: machine collections first, for the rich-text
    picker default.)
  - The `curios` collection has every core field name, then `material`, `acquiredFrom`.
  - Core fields, names copied from DT's `src/collections/shared.ts`: `title` (required),
    `titleHint`, `presence`, `tags` (relationship to `tags`, hasMany), `year`, `yearFrom`,
    `yearTo`, `monthFrom`, `monthTo`, `dateBasis`, `photos` (upload to `media`, hasMany),
    `description` (richText), `notes`, `provenance`, `acquisitionNotes`, `disposition`,
    `onLoanTo`, `purchaseInterest`. Copy each field's type, options and validation from DT.
    Leave out `admin.position` and tabs; M3 places fields. Keep DT's `setYearRangeFromYear`
    hook.
  - A plugin field named `title` throws `StartError`:
    `curios adds a field named "title", which the engine already defines.`
  - Two plugins adding the same field to one item type is not possible in M1 (no
    `extendItemType` yet); skip that case.
  - `slug: oddities` gives a collection `oddities` with labels from `label`.
  - `itemTypeSlugs(config)` returns `['curios']`.
- [ ] **Step 2:** Run the tests. Expected: fail.
- [ ] **Step 3:** Implement. `Users` and `Media` come from the template's files.
  `Tags`: `name` (text, required, unique), `slug` (text, unique). `app/src/payload.config.ts`
  becomes a call to `buildEngineConfig` with `catalog` from `app/src/catalog.ts`
  (`{ curios }`) and the environment values from Global Constraints. Add
  `@wonderroom/plugin-curios` to `transpilePackages`.
- [ ] **Step 4:** Run the tests, then `npm run build -w app`. Expected: pass; build succeeds.
- [ ] **Step 5:** Commit: `feat(core): build the Payload config from plugins; curios toy plugin`.

### Task 5: The items index, item references and delete rules

**Files:**
- Create: `packages/core/src/items.ts`
- Modify: `packages/core/src/config.ts` (add the `items` collection and the hooks to every
  item type)
- Test: `packages/core/test/items.test.ts`, `packages/core/test/helpers/db.ts`
- Test fixture: `packages/core/test/fixtures/catalog.ts`

**Interfaces:**
- Consumes: `buildEngineConfig` (Task 4).
- Produces:
  ```ts
  type OnItemDelete = 'remove-entry' | 'refuse'
  function itemReference(options: {
    name: string
    label?: string
    required?: boolean
    onItemDelete: OnItemDelete
  }): Field                                // relationship to 'items'
  function rebuildItemsIndex(payload: Payload): Promise<{ created: number; removed: number; retitled: number }>
  // test helper
  function withTestDatabase<T>(fn: (databaseUrl: string) => Promise<T>): Promise<T>
  ```
  The `items` collection: `itemType` (text, required, indexed), `itemId` (number, required,
  indexed), `title` (text); `admin.useAsTitle: 'title'`; the title reads
  `<title> (<singular label>)`, so equal titles across types stay apart in the picker.
  `itemReference` records its rule in the field's `custom.wonderroom.onItemDelete`.
  The engine finds every such field across all collections when it builds the config.
- Test fixture catalog: `curios` plus `toyItem(settings: { slug: string; extraFields?: Field[] })` (an item
  type) and `toyFeatured` (an add-on, collection `featured`, field
  `itemReference({ name: 'item', required: true, onItemDelete: 'remove-entry' })`) and
  `toyLedger` (an add-on, collection `ledger`, `itemReference({ name: 'item', required: true,
  onItemDelete: 'refuse' })`).

- [ ] **Step 1: Write the failing tests.** Each runs `getPayload` with `push: true` on its own
  test database (tests only; never in the engine's start).
  - Creating a curio creates one `items` row with its type, id and title. Updating its title
    updates the row. Deleting it deletes the row.
  - A `featured` entry links to a curio by its index row. Linking to index id 9999 fails.
  - Deleting a featured curio deletes the curio and its `featured` entry (`remove-entry`).
  - Deleting a curio that a `ledger` row points at throws an `APIError` with message
    `This curio has 1 ledger entry. Delete or move them first.` The curio, its index row and
    the ledger row all remain.
  - Bulk delete (`payload.delete` with a `where` matching two curios, one with a ledger row)
    deletes the free one and refuses the other, with the same message.
  - `rebuildItemsIndex` after a raw-SQL insert into `curios` creates the missing index row;
    after a raw-SQL delete from `curios` it removes the orphan row (when nothing references
    it) and reports the counts.
- [ ] **Step 2:** Run the tests. Expected: fail.
- [ ] **Step 3:** Implement. Index hooks: `afterChange` (create or retitle) and `afterDelete`
  (delete the row), both passing `req` so they share the transaction. Delete rules: a
  `beforeDelete` hook on every item type finds the index row, then each referencing field:
  `refuse` throws the `APIError` with the count and the referencing collection's plural label;
  `remove-entry` deletes the referencing documents.
- [ ] **Step 4:** Run the tests. Expected: pass.
- [ ] **Step 5:** Commit: `feat(core): items index, item references and delete rules`.

### Task 6: Schema change analysis (pure)

**Files:**
- Create: `packages/core/src/migrate/analyze.ts`
- Test: `packages/core/test/analyze.test.ts` (hand-built snapshots in the shape of
  `spikes/migrations/record/task2/*.json`: `tables["public.<name>"].columns[<col>] =
  { name, type, notNull, default? }`, `enums["public.<name>"] = { name, values }`)

**Interfaces:**
- Produces:
  ```ts
  type Snapshot = { tables: Record<string, any>; enums: Record<string, any> } & Record<string, unknown>
  type SchemaChange = {
    addedTables: string[]; removedTables: string[]
    addedColumns: { table: string; column: string; notNull: boolean; hasDefault: boolean }[]
    removedColumns: { table: string; column: string }[]
    addedEnums: string[]; removedEnums: string[]
    retypedColumns: { table: string; column: string; from: string; to: string }[]
    newlyNotNull: { table: string; column: string }[]   // existing columns that become NOT NULL
  }
  function analyzeSchemaChange(before: Snapshot, after: Snapshot): SchemaChange
  type MigrationPlan =
    | { kind: 'none' }
    | { kind: 'apply'; removals: Removal[] }            // removals: confirmed drops for phase 1
    | { kind: 'stop'; message: string }
  type Removal = { key: string; table: string; column?: string }
  function planMigration(change: SchemaChange, input: {
    confirm: string[]
    latestMigration: string | null       // file name without extension, e.g. 20261118_164300_wonderroom
    tablesWithRows: Set<string>
  }): MigrationPlan
  function removeFromSnapshot(before: Snapshot, removals: Removal[]): Snapshot
  ```
  Confirmation keys: `drop table <table> @ <latestMigration>`,
  `drop column <table>.<column> @ <latestMigration>`,
  `retype <table>.<column> @ <latestMigration>`. A confirmed table drop also covers its enums
  (`enum_<table>_*`) and its child tables (`<table>_*`).

- [ ] **Step 1: Write the failing tests.**
  - `analyzeSchemaChange` reports each kind of change for small before/after pairs, one test
    per field of `SchemaChange`.
  - `planMigration`:
    - only additions → `apply` with no removals.
    - no change → `none`.
    - a removed table, not confirmed → `stop`, and the message contains the exact line to add:
      `drop table coins @ 20261118_164300_wonderroom`.
    - the same, confirmed → `apply` with that removal.
    - a confirmation issued against an older migration name does not match → `stop`
      (Review Focus 3).
    - a table removed and another added, the removal not confirmed → `stop` with a message
      that names both tables and says the engine can't tell a rename from a swap.
    - the same with the removal confirmed → `apply` (the swap case; phase 1 removes, phase 2
      adds, so Drizzle never asks).
    - an enum removed and another added, not covered by a confirmed table drop → `stop`
      naming both enums.
    - every `stop` for a removed and added table also says: a plugin's slug can't change
      once created; change its label or URL path instead.
    - a column removed and another added in one table → `stop` naming the table and both
      columns. M1 has no declared renames; the message says so.
    - a retyped column → `stop` unless `retype …` is confirmed.
    - a new NOT NULL column with no default, or a column that becomes NOT NULL, on a table in
      `tablesWithRows` → `stop`, naming the table and column, saying the plugin must give the
      field a default. No confirmation key fixes this.
  - `removeFromSnapshot` deletes confirmed tables (with their child tables and enums) and
    columns, and leaves everything else the same.
- [ ] **Step 2:** Run the tests. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: pass.
- [ ] **Step 5:** Commit: `feat(core): schema change analysis and migration plan`.

### Task 7: The migrate command (the guard)

**Files:**
- Create: `packages/core/src/migrate/run.ts`, `packages/core/src/migrate/lock.ts`,
  `packages/core/src/migrate/files.ts`, `packages/core/bin/migrate.ts`
- Modify: `app/package.json` (script `migrate`:
  `cross-env NODE_ENV=production NODE_OPTIONS=--no-deprecation payload run ../packages/core/bin/migrate.ts`)
- Test: `packages/core/test/migrate.test.ts`, `packages/core/test/fixtures/payload.config.ts`
  (calls `buildEngineConfig` with the fixture catalog)

**Interfaces:**
- Consumes: `analyzeSchemaChange`, `planMigration`, `removeFromSnapshot` (Task 6);
  `rebuildItemsIndex` (Task 5); `buildEngineConfig` (Task 4).
- Produces: `bin/migrate.ts` exits 0 when the database matches the config, 1 with a
  `StartError` message otherwise. Payload's own CLI steps run as child processes with stdin
  ignored and a `WONDERROOM_STEP_TIMEOUT_MS` limit.
  ```ts
  function withMigrationLock<T>(databaseUrl: string, fn: () => Promise<T>): Promise<T>
  function runMigrations(payload: Payload, options: { dataDir: string; confirm: string[] }): Promise<void>
  ```

The steps `runMigrations` takes, in order. Each one is a rule from the M0 findings:

1. Take the advisory lock. Port DT's `src/scripts/migrate-locked.mjs`: a dedicated `pg`
   client, `pg_try_advisory_lock` with a bounded wait, the same timeout message.
2. If `payload_migrations` has a row with `batch = -1`: stop. Message: the database was
   changed by Payload's dev push; restore a backup or reset the database.
3. Delete generated files in `<dataDir>/migrations` that `payload_migrations` doesn't list
   (left by a start that died halfway), then rewrite `index.ts` with Payload's
   `writeMigrationIndex`.
4. If the folder has no snapshot but `payload_migrations` has rows: stop. Message: the
   migrations folder is missing or empty; restore it from the backup taken with the database.
5. Before = the latest snapshot (or `payload.db.defaultDrizzleSnapshot`). After =
   `generateDrizzleJson(payload.db.schema)` from `payload.db.requireDrizzleKit()`. Count rows
   in every table that has a new NOT NULL column. `planMigration`; on `stop`, throw.
6. If the plan has removals: `pg_dump --format=custom` to
   `<dataDir>/backups/before-<timestamp>.dump` (stop if `pg_dump` is missing or fails). Write
   phase 1: SQL from `generateMigration(before, removeFromSnapshot(before, removals))`,
   saved as `<ts>_wonderroom_removals.ts` plus its `.json` snapshot. Wait for the next whole
   second, so phase 2's timestamp sorts after it.
   `// ponytail: one-second wait orders the two files; use a counter suffix if starts get busy`
7. Run `payload migrate:create wonderroom --skip-empty`. If the plan expected changes beyond
   the removals and no new file appeared: stop (the silent exit 0 from M0).
8. Scan the new file's `up` SQL for `DROP TABLE`, `DROP COLUMN`, `DROP TYPE`,
   `SET DATA TYPE`, `SET NOT NULL`. Anything not covered by a confirmed removal: delete the
   file and its snapshot, and stop, showing the statements.
9. Run `payload migrate`. If it fails or times out: delete every generated file that
   `payload_migrations` doesn't list, rewrite `index.ts`, and stop with Payload's error.
10. `rebuildItemsIndex` and log its counts when any are non-zero.

A timed-out step stops with: `<step> did not finish in <n> s. It may be waiting for an
answer to a question. Nothing was applied.`

- [ ] **Step 1: Write the failing tests.** Each test makes a temp config folder and data
  folder, a test database, and runs `npm run migrate -w app` as a child process with
  `PAYLOAD_CONFIG_PATH` pointing at the fixture config. These are the M0 experiments, now as
  guard tests:
  - **First start:** `curios` → exit 0; tables `curios`, `items`, `users` exist.
  - **Add an item type:** then `curios, coins` → exit 0; `coins` exists; curio rows kept.
  - **Remove an item type:** then `curios` → exit 1; output contains
    `drop table coins @ `; `coins` still exists. Add the printed line under `confirm:` →
    exit 0; `coins` gone; a `.dump` file exists in `backups/`.
  - **Swap:** `curios, coins` → `curios, stamps` with the coins drop confirmed → exit 0;
    `stamps` exists, `coins` gone, no timeout.
  - **Undeclared rename:** `coins` with `extraFields: [material]` → `[metal]` → exit 1;
    output names `coins`, `material` and `metal`.
  - **Required field on a table with rows:** add a required `grade` field → exit 1 before
    anything is written; no new file in `migrations/`.
  - **Failed apply:** add `unique: true` to `material` while two coins share a value → exit 1;
    no unapplied file remains; the next start with the field fixed → exit 0.
  - **Halfway start:** copy a stray generated `.ts` and `.json` into `migrations/` → the next
    start deletes them and exits 0 (Review Focus 4).
  - **Dev push row:** insert a `payload_migrations` row with `batch -1` → exit 1 with the dev
    push message.
  - **Lost folder:** empty `migrations/` after a successful start → exit 1 with the missing
    folder message.
  - **Timeout:** `WONDERROOM_STEP_TIMEOUT_MS=1` → exit 1 with the timeout message.
  - **Two starts at once:** two `migrate` processes on a fresh database → both exit 0;
    `payload_migrations` holds each migration once.
- [ ] **Step 2:** Run the tests. Expected: fail.
- [ ] **Step 3:** Implement `lock.ts`, `files.ts` (list, delete unapplied, latest snapshot,
  write a migration file in the shape `migrate:create` writes), `run.ts`, `bin/migrate.ts`.
- [ ] **Step 4:** Run the tests. Expected: pass. If an M0 result differs on 3.94.0 (for
  example `migrate:create` no longer exits 0 on a prompt), record it in the ledger as a
  ruling and in `docs/spikes/2026-11-18-migrations-findings.md` under a new "3.94.0" note.
- [ ] **Step 5:** Commit: `feat(core): migrate command with the engine guard`.

### Task 8: The start command and the end-to-end check

**Files:**
- Modify: `app/package.json` (script `start:engine`: `npm run migrate && npm run start`),
  root `package.json` (script `start`)
- Modify: `app/tests/e2e/admin.e2e.spec.ts`, `app/playwright.config.ts` (start the app with
  `npm run migrate && npm run dev` against a fresh test database)
- Test: `app/tests/e2e/admin.e2e.spec.ts`, `packages/core/test/start.test.ts`
- Create: `README.md` (root): how to run the dev install in five commands

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing tests.**
  - E2E (Playwright, reusing the template's `seedUser` and `login` helpers): with
    `config/plugins.yml` listing `curios`, the admin nav shows "Curios", and creating a curio
    titled "Brass orrery" shows it in the list.
  - `start.test.ts`: `npm run migrate -w app` with a `plugins.yml` whose plugin requires a
    plugin that isn't listed exits 1 and prints the Task 2 missing-requirement message. A
    `requires` loop exits 1 with the loop message.
- [ ] **Step 2:** Run `npm test` and `npm run test:e2e -w app`. Expected: fail.
- [ ] **Step 3:** Wire the scripts and the Playwright web server. Write the README.
- [ ] **Step 4:** Run both. Expected: pass.
- [ ] **Step 5:** Commit: `feat: start command; end-to-end admin check`.

## Left out of M1, on purpose

- Declared renames (the M0 snapshot trick). The guard stops on any rename for now. M4 adds
  them when a real plugin needs one.
- `extendItemType`, money events, Featured and every DT plugin: M4. The delete rules are
  tested with fixture plugins.
- DT's EXIF crop patch for Payload: check whether 3.94.0 still needs it in M4, when photos
  come over.
- Public pages and privacy (M2), admin sections (M3), skin (M5), the image (M6).
