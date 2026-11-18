# Item reference test build: findings

Date: 2026-11-18. Code: `spikes/migrations/plugins.ts` (`WR_REF`) and `spikes/migrations/ref.ts`
on branch `spike/item-reference`. Logs: `spikes/migrations/record/item-reference/`. Same setup as the migrations test build: Payload 3.85.0,
Postgres 16, no Next.js, CLI runs with no terminal.

The question: how should Featured, Highlights and money events point at "any item"? Three
shapes:

- **poly**: Payload's polymorphic relationship, as DT does today. A `featured_rels` table with
  one column per item type.
- **pair**: two plain fields on Featured, `itemType` (text) and `itemId` (number). This is how
  Rails and Django do it.
- **index**: an engine-owned `items` table (`itemType`, `itemId`, `title`). Featured has a
  normal relationship to `items`. Hooks on every item type create, update and delete the index
  row.

## What happened

| | poly (M0) | pair | index |
|---|---|---|---|
| Add an item type (Coins) | Adds `coins_id` to `featured_rels` | Featured unchanged | Featured and `items` unchanged |
| Lock table | gains `coins_id` | gains `coins_id` | gains `coins_id` |
| Foreign key | yes, per type | **none** | yes, to `items` |
| Link to an id that doesn't exist | rejected | **accepted** (`coins` 9999 saved) | rejected by the database |
| Filter "featured coins" | by collection | `itemType = coins` works | `machine.itemType = coins` works (a join) |
| Delete a featured coin | `featured_rels` row cascades away; the Featured row stays with no machine, silently (read from the foreign key rule, not run) | coin deleted; Featured row points at nothing | **delete refused**, everything rolls back, coin kept |
| Title shown in the admin picker | from each collection | needs a custom field component | from `items.title`, a copy kept by the hook |

Details:

- **Adding a type** changes only the new type's tables and Payload's lock table, in both pair
  and index. No relationship table changes. The lock table still changes for every new
  collection, so the guard stays as decided.
- **The index delete error is misleading.** Payload's foreign key is `ON DELETE SET NULL`, but
  the field is required, so the column is `NOT NULL`. Postgres refuses the delete. Payload then
  reports a failure on an unrelated query (`delete from "payload_preferences"`), because the
  transaction has already been aborted. The data is safe. The message isn't usable.
- **Index ids are not item ids.** Coin 1 is index row 2. The engine must never show an index id
  in a URL.
- **The index keeps a copy of the title** so the stock picker can show it. The hook updated it
  on rename (tested).
- The pair's `itemId` is `numeric`, not `integer`, and Payload adds no index on either column.
  The engine would set both.
- Not tested: the admin picker's look (no Next.js in this build), and backfilling index rows
  for existing data.

## Reading

**Index is the stricter choice, and the stricter choice is what we want.** It keeps a real
foreign key, so the database refuses a link to a missing item, and it refuses to delete an item
that something still points at. Pair has neither: integrity becomes engine code that every
write path must remember, the same weakness as hand-written privacy. Today's poly shape is
the worst on delete: it loses the link silently.

What index costs:

1. A second row per item, kept in step by hooks, plus a title copy for the picker. Writes that
   skip Payload (raw SQL, a restore) can leave it out of step. The engine needs a rebuild
   command that recreates the index from the item tables, and the start sequence can run a
   cheap count check.
2. **Delete rules need engine code.** Payload always writes `ON DELETE SET NULL`. The engine
   needs a `beforeDelete` check on every item type that finds what points at the item and
   applies a rule per reference: Featured and Highlights drop their entry; money events refuse
   the delete with a clear message ("this item has 3 money events"). The database's refusal
   stays underneath as the backstop.
3. The picker shows only the title. If titles repeat across types ("Model 5"), the index title
   should include the type label. Check this when the admin is built.

## Recommendation

Use **index** for the engine's "any item" reference. Item types stay separate collections with
their own admin lists and their own ids, so DT's URLs don't change. The engine owns `items`,
its hooks, the rebuild command and the per-reference delete rules. Plugins see one reference
field from the engine and never `relationTo` a list of item types.

For DT's move: Featured, Highlights and money events change from `_rels` rows to an
`items` foreign key in the one-way migration, after the migration fills `items` from the three
item tables.
