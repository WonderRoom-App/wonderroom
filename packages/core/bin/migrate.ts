// `npm run migrate -w app`: brings the database in line with the config, or stops and says why.
// Runs under `payload run`. This module sets the exit code itself: 1 on failure, 0 on success,
// so nothing left open (a socket, a timer) can keep the process alive after the work is done.
import type { PostgresAdapter } from '@payloadcms/db-postgres'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPayload, type SanitizedConfig } from 'payload'
import { findConfig } from 'payload/node'
import { withMigrationLock } from '../src/migrate/lock'
import { runMigrations } from '../src/migrate/run'
import { StartError } from '../src/plugin'

try {
  const config: SanitizedConfig = await (await import(pathToFileURL(findConfig()).href)).default
  const payload = await getPayload({ config })
  const db = payload.db as unknown as PostgresAdapter
  try {
    await withMigrationLock(db.poolOptions.connectionString!, () =>
      runMigrations(payload, { dataDir: dirname(db.migrationDir), confirm: config.custom.wonderroom.confirm }),
    )
  } finally {
    await payload.destroy()
  }
  process.exit(0)
} catch (error) {
  console.error(error instanceof StartError ? error.message : error)
  process.exit(1)
}
