import pg from 'pg'
import { StartError } from '../plugin'

// Payload's migrate takes no lock of its own. Two starts at once would both see the same migration
// as pending and both write and run it. The advisory lock makes the second start wait.
// Stable on purpose: every start that migrates this database must use the same number.
const LOCK_KEY = 20261118

const POLL_INTERVAL_MS = 2_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `fn` while this process holds the migration lock. Waits a bounded time for it, so a start that
 * hangs while it holds the lock makes the next start fail loudly instead of wait forever.
 *
 * The lock lives on a dedicated client, not a pool: advisory locks belong to one session. Closing the
 * client frees the lock, and Postgres also frees it when the process dies and the connection drops.
 */
export async function withMigrationLock<T>(databaseUrl: string, fn: () => Promise<T>): Promise<T> {
  const waitMs = Number(process.env.WONDERROOM_LOCK_TIMEOUT_MS ?? 300_000)
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    // pg_try_advisory_lock returns at once instead of queueing, which makes the bounded wait possible.
    const deadline = Date.now() + waitMs
    let waited = false
    while (!(await client.query('select pg_try_advisory_lock($1) as ok', [LOCK_KEY])).rows[0].ok) {
      if (Date.now() >= deadline) {
        throw new StartError(
          `Another start has held the migration lock (key ${LOCK_KEY}) for more than ${Math.round(waitMs / 1000)} s. ` +
            'It may be stuck in a migration. Check the other running copies before you try again. ' +
            'WONDERROOM_LOCK_TIMEOUT_MS sets how long to wait.',
        )
      }
      if (!waited) console.log('Another start is migrating the database. Waiting for the lock.')
      waited = true
      await sleep(POLL_INTERVAL_MS)
    }
    if (waited) console.log('Took the migration lock.')
    return await fn()
  } finally {
    await client.end()
  }
}
