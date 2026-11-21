import pg from 'pg'
import { expect, test } from 'vitest'
import { msFromEnv, withMigrationLock } from '../src/migrate/lock'
import { pgDumpCommand } from '../src/migrate/run'
import { StartError } from '../src/plugin'
import { withTestDatabase } from './helpers/db'

test('pg_dump gets the connection in its environment, never in its arguments', () => {
  const { args, env } = pgDumpCommand('postgres://ann:s%40cret@db.example:6543/shop?sslmode=require', '/data/backups/b.dump')
  expect(args.join(' ')).not.toMatch(/s@cret|s%40cret/)
  expect(args).toEqual(['--format=custom', '--file=/data/backups/b.dump', '--no-password'])
  expect(env).toEqual({ PGHOST: 'db.example', PGPORT: '6543', PGUSER: 'ann', PGPASSWORD: 's@cret', PGDATABASE: 'shop', PGSSLMODE: 'require' })
})

test('time limits must be positive numbers of milliseconds', () => {
  const name = 'WONDERROOM_TEST_LIMIT_MS'
  try {
    delete process.env[name]
    expect(msFromEnv(name, 5)).toBe(5)
    process.env[name] = '250'
    expect(msFromEnv(name, 5)).toBe(250)
    for (const bad of ['0', '-5', 'abc', 'Infinity', '']) {
      process.env[name] = bad
      expect(() => msFromEnv(name, 5)).toThrow(StartError)
      expect(() => msFromEnv(name, 5)).toThrow(name)
    }
  } finally {
    delete process.env[name]
  }
})

test('a dropped lock connection fails the start with a StartError', { timeout: 30_000 }, () =>
  withTestDatabase(async (databaseUrl) => {
    let finish = () => {}
    const held = new Promise<void>((resolve) => (finish = resolve))
    const locked = withMigrationLock(databaseUrl, () => held)
    const admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    try {
      const lockHolder = `select pid from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`
      while ((await admin.query(lockHolder)).rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 50))
      await admin.query(`select pg_terminate_backend(pid) from (${lockHolder}) holders`)
      await expect(locked).rejects.toThrow(/migration lock/)
      await expect(locked).rejects.toBeInstanceOf(StartError)
    } finally {
      finish()
      await admin.end()
    }
  }))
