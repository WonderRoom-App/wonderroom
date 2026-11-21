# WonderRoom

WonderRoom is a self-hosted catalog for collectors. You pick plugins in one file, and the engine builds the admin and the database tables to match. It runs on [Payload](https://payloadcms.com) and Postgres.

## Dev install in five commands

You need Node 24 (or 22.23.5 or newer), Docker, and `pg_dump`.

```sh
git clone <this repo> && cd WonderRoom
npm install
cp app/.env.example app/.env
npm run db:up
npm run migrate -w app && npm run dev
```

Open <http://localhost:3000/admin>. Payload asks you to make the first admin user.

Edit `app/.env` first if you want a different `PAYLOAD_SECRET`. The example file works with the Docker database from `npm run db:up`.

## Choose plugins

`config/plugins.yml` lists the plugins you want.

```yaml
plugins:
  - use: curios
```

Each start reads this file. A new plugin adds its tables. A removed plugin stops the start until you confirm (see below).

If a plugin needs another plugin, list both. A missing or circular requirement stops the start with a message that names the plugins.

The start also stops in these cases:

- A new required field has no default, and its table already has rows. The same applies to a field that becomes required.
- The migration files and the database disagree. This covers a dev push row, a missing file, an out-of-order file, and an empty database with a full migrations folder.

Each message says what to do.

## Start commands

- `npm run migrate -w app` brings the database in line with `plugins.yml`, or stops and says why.
- `npm run dev` starts the dev server.
- `npm run start:engine -w app` runs migrate, then starts the production server. Run `npm run build -w app` first.
- `npm test` runs the unit tests. They need the dev database from `npm run db:up`.
- `npm run test:e2e -w app` runs the browser check. It needs the same database.

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | none (required) | Postgres connection string. |
| `PAYLOAD_SECRET` | none (required) | Secret that signs logins. Use a long random value. |
| `WONDERROOM_CONFIG_DIR` | `config` in the repo root | Folder that holds `plugins.yml`. |
| `WONDERROOM_DATA_DIR` | `data` in the repo root | Folder for migrations and backups. Back it up with the database. |
| `WONDERROOM_STEP_TIMEOUT_MS` | `300000` (5 minutes) | Longest time one migrate step may run. |
| `WONDERROOM_LOCK_TIMEOUT_MS` | `300000` (5 minutes) | Longest time a start waits for another start to finish. |

Relative paths count from the `app` folder.

WonderRoom turns off Payload's telemetry by default. Your catalog sends no usage data to Payload.

## Confirm lines

Some changes can destroy data. Removing a plugin drops its tables. Changing a field type or removing a select option can lose values.

WonderRoom stops before it does any of these. It prints a line for each one, such as:

```
drop table coins @ 20261118_101500_wonderroom
```

To allow the change, copy the line into `plugins.yml`:

```yaml
plugins:
  - use: curios
confirm:
  - drop table coins @ 20261118_101500_wonderroom
```

Start again. WonderRoom takes a database backup into the data folder, then applies the change. The name after `@` is the latest migration at the time of the stop. A line only works while that migration is still the latest. After any new migration, you must confirm again.
