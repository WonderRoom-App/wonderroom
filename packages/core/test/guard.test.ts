import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { describe, expect, test } from 'vitest'
import { analyzeSchemaChange, type Snapshot } from '../src/migrate/analyze'
import { msFromEnv, withMigrationLock } from '../src/migrate/lock'
import { pgDumpCommand, uncoveredStatements } from '../src/migrate/run'
import { StartError } from '../src/plugin'
import { withTestDatabase } from './helpers/db'

test('pg_dump connects where the pool connects, and its password stays out of its arguments', () => {
  const ambient = { PGHOST: 'elsewhere', PGPORT: '9999', PGUSER: 'bob', PGDATABASE: 'other', PGPASSWORD: 'wrong' }
  const saved = { ...process.env }
  Object.assign(process.env, ambient)
  try {
    const withPort = pgDumpCommand('postgres://ann:s%40cret@db.example:6543/shop?sslmode=verify-full', '/data/backups/b.dump')
    expect(withPort.args.join(' ')).not.toMatch(/s@cret|s%40cret/)
    expect(withPort.args).toEqual([
      '--format=custom',
      '--file=/data/backups/b.dump',
      '--no-password',
      "--dbname=host='db.example' port='6543' user='ann' dbname='shop' sslmode='verify-full'",
    ])
    expect(withPort.env.PGPASSWORD).toBe('s@cret')

    // node-pg fills a part the URL leaves out from the same PG* variables, so pg_dump gets the values it used.
    const socket = pgDumpCommand("postgres://ann:pw@/sh'op?host=/var/run/postgresql", '/b.dump')
    expect(socket.args.at(-1)).toBe("--dbname=host='/var/run/postgresql' port='9999' user='ann' dbname='sh\\'op'")
    for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE']) expect(socket.env).not.toHaveProperty(name)
    expect(socket.env.PGPASSWORD).toBe('pw')
    expect(socket.env.PATH).toBe(process.env.PATH)
  } finally {
    for (const name of Object.keys(ambient)) delete process.env[name]
    Object.assign(process.env, saved)
  }
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

describe('the safety scan of a generated migration', () => {
  const empty: Snapshot = { tables: {}, enums: {} }
  const scan = (source: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'wonderroom-')), '20261118_000000_wonderroom.ts')
    writeFileSync(file, source)
    return uncoveredStatements(file, { before: empty, change: analyzeSchemaChange(empty, empty), confirm: [], latest: null })
  }

  test('reads all of up, whatever runs the SQL', () => {
    const source = `export async function up({ db }) {\n  await db.execute(sql.raw('DROP TABLE "coins" CASCADE;'))\n}\n\nexport async function down({ db }) {\n  await db.execute(sql\`CREATE TABLE "coins" ();\`)\n}\n`
    const uncovered = scan(source)
    expect(uncovered).toHaveLength(1)
    expect(uncovered[0]).toContain('DROP TABLE "coins" CASCADE')
  })

  test('stops when the file has no up function it can find', () => {
    const source = `export const migration = { up: async ({ db }) => db.execute(sql\`DROP TABLE "coins"\`) }\n`
    expect(() => scan(source)).toThrow(StartError)
    expect(() => scan(source)).toThrow(/20261118_000000_wonderroom\.ts has no up function the engine can read/)
  })
})
