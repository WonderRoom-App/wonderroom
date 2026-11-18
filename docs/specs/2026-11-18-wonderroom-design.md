# WonderRoom: a plugin engine for collection sites

Status: approved design, 2026-11-18.

The name comes from *Wunderkammer*, the "wonder room" or cabinet of curiosities: one
collector's mixed collection, shown to guests. "Parlor" is held in reserve as a secondary name
(for example, for the default theme).

## Why

Other collectors want a site like Dynamically Typed for their own collections. One collector
wants ancient coins, typewriters and staplers on one site. Today the code knows only three
item types, and 27 files name `typewriters`, `calculators` or `marvels` directly.

The goal is a public, open-source engine. Each kind of collection is a plugin. Each collector
hosts their own copy. Dynamically Typed (DT) becomes the first install.

The people who will run it are mostly not developers. They must not need to fork a repo or
write a Dockerfile.

## Goals

- **One engine, many item types.** An item type (Typewriters, Coins) is a plugin.
- **Plugins build on plugins.** "TWDB for typewriters" needs Typewriters and Makers. The engine
  checks these needs at start.
- **Themes are plugins.** A theme can change only colors and fonts, or replace parts of the
  layout.
- **Deploy without building.** An owner mounts a config folder, a media folder and a Postgres
  volume, then starts the container. The site appears.
- **DT version 1 parity.** DT runs on the engine and no visitor sees a change. URLs, pages and
  content stay the same.
- **A clean admin page.** Every field sits in a named section. A plugin says which section its
  fields go in.

## Non-goals (version 1)

These wait until DT runs cleanly on the engine. The design must allow each one, and the
sections below say how.

- Coins, Staplers or any new item type.
- Dates before year 1 (BCE).
- Third-party plugins from npm or git.
- Two copies of one item type on one site.
- A plugin store, or turning plugins on and off from the admin page.

## Anti-goals

- **Multi-tenant hosting.** One site has one owner. We never host other people's sites, and
  the code never separates data between users.
- **A fork-to-install model.** If an owner has to merge upstream changes into a fork, the
  design has failed.
- **Item types that depend on each other.** Typewriters never extends Marvels or any other
  item type. Shared code lives in the engine or in an add-on. This keeps the rule DT already
  has: `collection → shared`, never `collection → collection`.
- **A visible change on DT** because of the move. Data may change shape. What visitors see may
  not.

## Constraints

- Stack stays Payload v3, Next.js, Postgres and Node 24.
- **Target hardware:** a DigitalOcean droplet. 2 GB of memory with swap is the minimum we test
  on. 4 GB is comfortable. Measure a real `next build` of DT before we commit to these numbers.
  A Raspberry Pi or a low-end NAS is not a target.
- **Privacy stays strict.** Today every public query uses `overrideAccess: false`, a `select`
  whitelist and the `PublicMachine` DTO, so private fields never reach the page. The engine must
  keep this guarantee for every plugin, including plugins we didn't write.
- **Data may change shape.** DT's data can move through a one-way migration if that makes the
  engine cleaner. The pg_dump backup is the safety net. Write up-migrations only.

## Approaches considered

**A. Plugins are npm packages. The engine owns the Next.js app. (Chosen.)**
The engine repo holds the engine and the first-party plugins as npm workspaces, published to
npm. The engine's Next.js app keeps real route folders for its own pages. Plugin pages go
through one catch-all route and a route table.

- For: upgrades are a version bump. Plugins can come from anyone. Payload serves its own admin
  the same way (`admin/[[...segments]]`).
- Against: catch-all pages lose Next.js's per-folder extras (layouts, loading files,
  intercepting routes). This matters little here, because the engine keeps real folders for
  its own pages, including the item page and its photo lightbox. Plugin pages are simple list
  and detail pages.

**B. A starter repo that owners fork. (Rejected.)** Pages stay ordinary files, but every
upgrade is a git merge into each owner's fork. Too hard for the owners we expect.

**C. A script writes route files from plugins at build time. (Dropped.)** It does what A does,
with more moving parts.

Joel picked A.

## Design

### The four kinds of plugin

1. **Item types**: Typewriters, Calculators, Marvels. Later Coins and Staplers. Each one
   defines a Payload collection on top of the core fields.
2. **Add-ons**: shared pieces that item types opt into. Examples: Makers (one Facit row serves
   a typewriter and a calculator), Condition, YouTube, Blog. ("Add-on" and not "feature",
   because `feature` is already a field name.)
3. **Integrations**: eBay, TWDB. They connect to outside services, and they depend on item
   types or add-ons.
4. **Themes**: a skin or a full theme (see Theming).

All four use one plugin shape. The kind is a label for people, not a separate API.

### Plugin shape

A plugin is a factory function. It takes the owner's settings and returns a plugin object.
A sketch, not a final API:

```ts
export default function typewriters(settings: { slug?: string; label?: string } = {}) {
  const slug = settings.slug ?? 'typewriters'
  return definePlugin({
    name: 'typewriters',
    kind: 'item-type',
    requires: ['makers', 'condition'],
    itemType: {
      slug,
      labels: { singular: 'Typewriter', plural: 'Typewriters' },
      fields: [/* ribbonSize, twoColor, layout */],
      sections: { details: ['ribbonSize', 'twoColor', 'layout'] },
      publicRows: (item) => [{ label: 'Ribbon size', value: item.ribbonSize }],
    },
  })
}
```

Rules:

- **No literal slugs.** A plugin uses the slug it was given, never `'typewriters'` in code.
  This is what makes two copies of one item type possible later. Payload makes a table per
  collection slug, so a second copy gets its own tables with no extra work.
- **`requires`** names other plugins. At start the engine sorts plugins so each one loads after
  what it needs. A missing plugin or a loop stops the start with a clear message.
- **Extending another plugin.** An integration adds fields to an item type through the engine,
  for example `extendItemType('typewriters', fields, 'twdb')`. It never edits the other
  plugin's config object directly.
- **Item type registry.** The engine keeps the list of loaded item types. Every place that
  names the three slugs today reads this list instead: home page groups, tags, focus
  expressions, statistics, timeline, search, relationships.
- **Relationships to "any item".** Featured, Highlights and money events already use a
  polymorphic relationship: `relationTo: ['typewriters', 'calculators', 'marvels']`. In the
  engine the registry builds that list. DT's data shape stays the same. Adding an item type
  later adds a column to those relationship tables, which a migration handles. (Builder check
  correction; the first draft wrongly said the shape changes.)

### The core item contract

The engine adds these fields to every item type. A plugin can't remove them.

- title, titleHint
- photos (and the photo manager), cardImage logic
- presence (in the collection, departed, parts)
- tags
- dates: year text, yearFrom, yearTo, monthFrom, monthTo, dateBasis
- provenance, notes
- private fields: acquisition notes, disposition, on loan to, purchase interest
- money events (private). Owners who don't track money leave them empty.

Sort of today's fields:

| Where | Fields |
|---|---|
| **Core** | listed above |
| **Makers add-on** | manufacturer, model, serialNumber, countryOverride, the Manufacturers collection with its family tree |
| **Condition add-on** | status, restoration groups (restorationGroup, isActiveInGroup, restorationRole), `blankStatusOnLeaving` |
| **YouTube add-on** | youtubeUrl, the video half of cardImage, the Videos collection, `sync:youtube` |
| **Blog, Highlights, Featured, Recommendations add-ons** | their collections and pages |
| **eBay integration** | the import button, the eBay connection global. Requires money events (core). |
| **TWDB integration** | twdbUrl, twdbYear, twdbBrand, twdbModel, the push button and endpoints. Requires Typewriters and Makers. |
| **Typewriters** | ribbonSize, twoColor, layout |
| **Calculators** | entryType, capacity, carry, backTransfer |
| **Marvels** | its own fields |

`twdbUrl` is in `linkFields` today, so Calculators and Marvels carry it too. It moves to TWDB.

### Privacy in the engine

Today each public query must remember the privacy rule. In the engine, plugins never write
public queries for item data. The engine builds the public `select` whitelist from what each
plugin declares public, then maps to the public DTO. A field that no plugin declares public
never reaches a page. **Default is private.** Plugin pages that read their own collections
(Blog, Makers) use an engine helper that forces `overrideAccess: false`.

**The owner's view.** When the owner is logged in, DT's public site shows more today: hidden
photos with badges on the item page, private facets on `/focus`, and the `/loans` and
`/report` pages. `/loans/actions.ts` also writes data. So the engine has two query paths:

- **Public path**: the whitelist above. This is the default.
- **Owner path**: full fields. The helper checks the logged-in user itself and returns nothing
  for a visitor. A plugin can't skip that check, because the check lives in the helper, not
  in the plugin.

The leak check runs every page twice, as a visitor and as the owner. As a visitor, no private
value may appear. (My call, from the builder check.)

Keep DT's existing check that no private value appears in rendered HTML. Run it against every
plugin page.

### Public pages

- **Engine pages** are real route folders in the engine's Next.js app: home, item page (with
  the `@modal/(.)photo` lightbox), past, tags, focus, timeline, statistics, countries/regions.
- **Plugin pages** register in a route table, for example `/manufacturers/:slug` → a page
  component with a metadata function. A catch-all route looks up the path, renders the match,
  and builds the page metadata. Two plugins that claim one path stop the start with a clear
  message.
- **Item fields on pages.** A theme can't know about ribbon size or coin grade. Each item type
  gives the engine `publicRows`, a list of label and value rows. The theme only shows the list.
- **Item URLs.** One engine function builds every item URL: pages, cards, rich-text links and
  the sitemap. After DT parity, item URLs get optional text after the id:
  `/typewriters/15-smith-corona-sterling` is item 15. The id alone finds the item. If the
  text is missing or out of date, the server redirects to the current URL. A title change
  then never breaks a link. Until parity, the function builds plain `/<path>/<id>` URLs.

Owners of DT's other pages: `/parts`, `/loans` and `/report` read core fields, so they are
engine pages. `/groups/[slug]` belongs to the Condition add-on with restoration groups.
`/figureshift` becomes a row in the core Pages collection (below).

**Pages (core).** A Pages collection holds rich-text pages at slugs the owner picks, edited in
the admin: About, Contact, FigureShift. The engine serves them through the catch-all route.
Engine and plugin routes win over a page slug, and a clash shows a warning in the admin.
DT's hand-built `/figureshift` page moves into a Pages row. Check that it looks the same.

Countries and regions come from the Makers add-on today. The builder decides whether they stay
engine pages that appear only when Makers is loaded, or move into Makers.

### The admin page

The engine owns a fixed list of sections, shown as tabs. A plugin puts each field in a section
by name. Proposed list (builder refines with Joel):

- **Overview**: title, titleHint, presence, status, tags
- **Details**: maker, model, serial number, dates, the item type's own fields
- **Photos & media**: photos, card image, video
- **Story**: provenance, notes, description
- **Private**: acquisition, money events, disposition, loans, purchase interest
- **One tab per integration**, such as "Typewriter Database" and "eBay"

The sidebar keeps only the "view live page" link and a few state fields.

**Use label-only tabs.** A Payload tab with a `name` stores its fields as a nested group and
renames the columns. A tab with only a `label` changes nothing in the database.

Keep machine collections first in the Payload `collections` array. The rich-text relationship
picker defaults to the first one.

### Theming

Two levels:

- **A skin** sets colors, fonts, logo, site name and banner. It sits on the core layout. Every
  color and font in today's `styles.css` becomes a CSS variable. A skin is settings, not code,
  so the engine reads it at start and a change needs only a restart. DT becomes the core layout
  plus a "typed on paper" skin.
- **A full theme** is a plugin. It replaces any of a short list of named layout parts: site
  frame (header, menu, footer), item card, item page. Any part it doesn't replace falls back
  to the core layout. A full theme is code, so adding one needs a build.

### Deployment

The owner's whole install:

```
docker-compose.yml   (we ship it)
config/
  plugins.yml        which plugins, which versions, instance settings (slug, for)
  config.d/          one YAML file per plugin: site name, skin, API keys
media/
pgdata/
```

Sketch of `plugins.yml`:

```yaml
plugins:
  - use: typewriters
  - use: calculators
  - use: makers
  - use: twdb
    for: typewriters
  - use: some-third-party-plugin
    from: git+https://example.org/plugin.git#v1.2.0
```

At start the container:

1. Reads `plugins.yml` and hashes the plugin list.
2. If every plugin is first-party, uses the prebuilt app in the image. The image holds all
   first-party plugins already built. The Payload config is built at server start from the
   config files, so plugins not listed stay off.
3. If any plugin is third-party, checks a build cache in a volume against the hash. On a match
   it starts. On a miss it installs the plugins, runs `payload generate:importmap` and
   `next build`, and saves the build.
4. Runs database migrations.
5. Starts the site.

Settings in `config.d` never trigger a build, only a restart.

**Two kinds of config.** The plugin list can change the bundle, but only when it names a
third-party plugin. Settings never change the bundle.

**What version 1 builds.** Version 1 builds the prebuilt first-party image, `plugins.yml`
and `config.d` read at start, migrations at start, and the skin. It does not build the
third-party install and build-cache path (step 3 above), full themes, or npm publishing. The
image is built straight from the engine repo's workspaces. The design above stays, so those
pieces can come later without a redesign. (My call, from the builder check.)

### Migrations: generated per install, inside an engine guard

**Decided after the M0 test build (Joel, 2026-11-18).** Evidence:
`docs/spikes/2026-11-18-migrations-findings.md`.

Plugins don't ship migrations. Polymorphic relationship tables and Payload's own
`payload_locked_documents_rels` get a column for every collection, so only a diff of the
whole config can own them. At start the engine runs the stock `payload migrate:create`, then
`payload migrate`. The migration files and snapshots live in a volume, beside the database.

The stock tools fail quietly with no terminal, so the engine wraps them in a guard:

- **Ambiguity:** before the diff, find anything that disappears while something similar
  appears: columns, enums, child tables, whole tables. If a plugin declared that rename, the
  engine writes the rename migration and a matching snapshot. If not, the start stops and
  names what it found.
- **Renames:** a plugin version ships a rename list (`field`, `to`, `since`).
- **Data loss:** if the generated SQL holds `DROP TABLE`, `DROP COLUMN`, `DROP TYPE`,
  `SET DATA TYPE`, or a `NOT NULL` with no default on a table with rows, the start stops and
  shows the SQL. The owner either puts the plugin back or confirms the change in
  `plugins.yml`. A confirmation also answers "new, not renamed" when one plugin is swapped for
  another. The engine makes a `pg_dump` before it applies a confirmed change.
- **Relationship shape changes** (single to many) need a data move. Version 1 stops the start
  with a clear message.
- **Never hang or pass silently:** a time limit on every step; stop if a diff was expected and
  no file appeared; stop if `payload_migrations` holds a `dev` push row.
- **Undo a failed apply:** delete the generated files, so the snapshot never gets ahead of the
  database.
- **One start at a time:** a Postgres advisory lock around the whole step.
- **A slug is fixed once created.** Rich-text references store the slug inside JSON, where no
  schema diff can see it. A changed slug for an existing item type stops the start. The owner
  changes the label or the URL path instead, so routes must not equal the slug.

The guard reads Drizzle's snapshot format, which is not a public Payload API. Pin Payload, and
run the M0 experiments as guard tests on every upgrade.

### Outbound requests

The engine sends every outbound request with a User-Agent built from the owner's site name
and URL.

## What's left to the builder

- The final plugin API names and types.
- The exact admin section list and the order of fields in each.
- How the route table matches paths.
- How the prebuilt image turns first-party plugins on and off.
- The build-cache layout.
- Whether countries and regions are engine pages or Makers pages.
- The Recommendations reshape.
- The order of work, after the migrations spike.

## Open questions

- **Name checks.** "WonderRoom" is chosen. The GitHub org is `WonderRoom-App`. npm
  `@wonderroom/core` is free. Trademarks are not checked yet.
- **A public image registry.** Owners need a public place to pull the image from. The image
  may be too big for GHCR, so it may need to shrink. This can wait until after DT parity.
