# Migrations test build (M0, throwaway)

A Payload app with no Next.js. `WR_PLUGINS` lists toy plugins (see `plugins.ts`); any name that
is not an add-on (`makers`, `featured`) becomes an item type with that slug.

    PGPASSWORD=postgres createdb -h localhost -p 5433 -U postgres wr_spike
    mkdir -p volume/migrations
    WR_PLUGINS=typewriters,makers,featured ./run.sh migrate:create init
    WR_PLUGINS=typewriters,makers,featured ./run.sh migrate

`run.sh` runs the CLI with no terminal and a 120 s limit, like a container start.
Findings: `docs/spikes/2026-11-18-migrations-findings.md`.
