import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { describe, expect, test } from 'vitest'
import { stringify } from 'yaml'
import { withTestDatabase } from './helpers/db'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureConfig = fileURLToPath(new URL('./fixtures/payload.config.ts', import.meta.url))
// Not the system temp folder: migration files import @payloadcms/db-postgres, so the data
// folder must sit where Node can find node_modules.
const tmpRoot = fileURLToPath(new URL('../.tmp/', import.meta.url))

type Entry = Record<string, unknown>
const curios: Entry = { use: 'curios' }
const toy = (slug: string, extraFields?: Entry[]): Entry => ({ use: 'toy-item', slug, ...(extraFields && { extraFields }) })
const coins = toy('coins')
const text = (name: string, more: Entry = {}): Entry => ({ name, type: 'text', ...more })

type Start = { code: number | null; output: string }

/** One install: a config folder, a data folder and a test database, started with `npm run migrate -w app`. */
function withInstall(fn: (install: ReturnType<typeof makeInstall>) => Promise<void>) {
  return withTestDatabase(async (databaseUrl) => {
    mkdirSync(tmpRoot, { recursive: true })
    const root = mkdtempSync(join(tmpRoot, 'migrate-'))
    try {
      await fn(makeInstall(root, databaseUrl))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

function makeInstall(root: string, databaseUrl: string) {
  const configDir = join(root, 'config')
  const dataDir = join(root, 'data')
  const migrationsDir = join(dataDir, 'migrations')
  mkdirSync(configDir)
  mkdirSync(dataDir)
  return {
    databaseUrl,
    migrationsDir,
    dataDir,
    plugins(entries: Entry[], confirm: string[] = []) {
      writeFileSync(join(configDir, 'plugins.yml'), stringify({ plugins: entries, confirm }))
    },
    start(env: Record<string, string> = {}): Promise<Start> {
      return new Promise((resolve, reject) => {
        const child = spawn('npm', ['run', 'migrate', '-w', 'app'], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PAYLOAD_CONFIG_PATH: fixtureConfig,
            WONDERROOM_CONFIG_DIR: configDir,
            WONDERROOM_DATA_DIR: dataDir,
            DATABASE_URL: databaseUrl,
            ...env,
          },
        })
        let output = ''
        child.stdout.on('data', (chunk) => (output += chunk))
        child.stderr.on('data', (chunk) => (output += chunk))
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, output }))
      })
    },
    async sql(text: string): Promise<any[]> {
      const client = new pg.Client({ connectionString: databaseUrl })
      await client.connect()
      try {
        return (await client.query(text)).rows
      } finally {
        await client.end()
      }
    },
    async tableExists(table: string): Promise<boolean> {
      return (await this.sql(`select to_regclass('public.${table}') is not null as found`))[0].found
    },
    files: () => readdirSync(migrationsDir).sort(),
  }
}

const expectExit = (start: Start, code: number) => expect(start.code, start.output).toBe(code)
const confirmLine = (output: string, action: string) => {
  const line = output.match(new RegExp(`${action} @ \\S+`))?.[0]
  if (!line) throw new Error(`no "${action}" line in:\n${output}`)
  return line
}

describe('the migrate command', { timeout: 180_000 }, () => {
  test('first start creates the tables', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      expectExit(await install.start(), 0)
      for (const table of ['curios', 'items', 'users']) expect(await install.tableExists(table)).toBe(true)
    }))

  test('adding an item type keeps the rows', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      expectExit(await install.start(), 0)
      await install.sql(`insert into curios (title) values ('Brass key')`)
      install.plugins([curios, coins])
      expectExit(await install.start(), 0)
      expect(await install.tableExists('coins')).toBe(true)
      expect(await install.sql('select title from curios')).toEqual([{ title: 'Brass key' }])
    }))

  test('removing an item type stops until the owner confirms, then backs up and drops', () =>
    withInstall(async (install) => {
      install.plugins([curios, coins])
      expectExit(await install.start(), 0)
      await install.sql(`insert into coins (title) values ('Penny')`)
      install.plugins([curios])
      const stopped = await install.start()
      expectExit(stopped, 1)
      expect(stopped.output).toContain('drop table coins @ ')
      expect(await install.tableExists('coins')).toBe(true)

      install.plugins([curios], [confirmLine(stopped.output, 'drop table coins')])
      expectExit(await install.start(), 0)
      expect(await install.tableExists('coins')).toBe(false)
      expect(readdirSync(join(install.dataDir, 'backups')).some((file) => file.endsWith('.dump'))).toBe(true)
    }))

  test('a swap with the drop confirmed creates the new table', () =>
    withInstall(async (install) => {
      install.plugins([curios, coins])
      expectExit(await install.start(), 0)
      install.plugins([curios, toy('stamps')])
      const stopped = await install.start()
      expectExit(stopped, 1)
      install.plugins([curios, toy('stamps')], [confirmLine(stopped.output, 'drop table coins')])
      const swapped = await install.start()
      expectExit(swapped, 0)
      expect(swapped.output).not.toContain('did not finish')
      expect(await install.tableExists('stamps')).toBe(true)
      expect(await install.tableExists('coins')).toBe(false)
    }))

  test('an undeclared rename stops and names the table and both columns', () =>
    withInstall(async (install) => {
      install.plugins([toy('coins', [text('material')])])
      expectExit(await install.start(), 0)
      install.plugins([toy('coins', [text('metal')])])
      const stopped = await install.start()
      expectExit(stopped, 1)
      for (const name of ['coins', 'material', 'metal']) expect(stopped.output).toContain(name)
    }))

  test('a required field on a table with rows stops before anything is written', () =>
    withInstall(async (install) => {
      install.plugins([curios, coins])
      expectExit(await install.start(), 0)
      await install.sql(`insert into coins (title) values ('Penny')`)
      const files = install.files()
      install.plugins([curios, toy('coins', [text('grade', { required: true })])])
      const stopped = await install.start()
      expectExit(stopped, 1)
      expect(stopped.output).toContain('coins.grade')
      expect(install.files()).toEqual(files)
    }))

  test('removing a select option stops until the owner confirms, then keeps the other rows', () =>
    withInstall(async (install) => {
      const grade = (options: string[]) => toy('coins', [{ name: 'grade', type: 'select', options }])
      install.plugins([grade(['fine', 'good', 'poor'])])
      expectExit(await install.start(), 0)
      await install.sql(`insert into coins (title, grade) values ('Penny', 'fine')`)
      install.plugins([grade(['fine', 'good'])])
      const stopped = await install.start()
      expectExit(stopped, 1)
      install.plugins([grade(['fine', 'good'])], [confirmLine(stopped.output, 'drop values enum_coins_grade.poor')])
      expectExit(await install.start(), 0)
      expect(await install.sql('select grade from coins')).toEqual([{ grade: 'fine' }])
    }))

  test('a failed apply leaves no unapplied file, and the next start works', () =>
    withInstall(async (install) => {
      install.plugins([toy('coins', [text('material')])])
      expectExit(await install.start(), 0)
      await install.sql(`insert into coins (title, material) values ('Penny', 'copper'), ('Cent', 'copper')`)
      const files = install.files()
      install.plugins([toy('coins', [text('material', { unique: true })])])
      expectExit(await install.start(), 1)
      expect(install.files()).toEqual(files)
      install.plugins([toy('coins', [text('material')])])
      expectExit(await install.start(), 0)
    }))

  test('a start that died halfway leaves files the next start deletes', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      expectExit(await install.start(), 0)
      const [applied] = install.files().filter((file) => file.endsWith('.ts') && file !== 'index.ts')
      const name = applied.slice(0, -3)
      const stray = '29991231_235959_wonderroom'
      copyFileSync(join(install.migrationsDir, `${name}.ts`), join(install.migrationsDir, `${stray}.ts`))
      copyFileSync(join(install.migrationsDir, `${name}.json`), join(install.migrationsDir, `${stray}.json`))
      expectExit(await install.start(), 0)
      expect(install.files().filter((file) => file.startsWith(stray))).toEqual([])
      expect(readFileSync(join(install.migrationsDir, 'index.ts'), 'utf8')).not.toContain(stray)
    }))

  test('an empty database never clears the migration history', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      expectExit(await install.start(), 0)
      const files = install.files()
      await withTestDatabase(async (emptyUrl) => {
        const stopped = await install.start({ DATABASE_URL: emptyUrl })
        expectExit(stopped, 1)
        expect(stopped.output).toContain(`The database has no migration history, but ${install.migrationsDir} holds 1 migrations. Check DATABASE_URL.`)
      })
      expect(install.files()).toEqual(files)
    }))

  test('a dev push row stops the start', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      expectExit(await install.start(), 0)
      await install.sql(`insert into payload_migrations (name, batch) values ('dev', -1)`)
      const stopped = await install.start()
      expectExit(stopped, 1)
      expect(stopped.output).toContain("Payload's dev push changed this database")
    }))

  test('a lost migrations folder stops the start', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      expectExit(await install.start(), 0)
      for (const file of install.files()) rmSync(join(install.migrationsDir, file))
      const stopped = await install.start()
      expectExit(stopped, 1)
      expect(stopped.output).toContain('is missing or empty')
    }))

  test('a step that runs too long stops the start', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      const stopped = await install.start({ WONDERROOM_STEP_TIMEOUT_MS: '1' })
      expectExit(stopped, 1)
      expect(stopped.output).toContain('did not finish in 0.001 s. It may be waiting for an answer to a question. Nothing was applied.')
      expect(install.files()).toEqual(['index.ts'])
    }))

  test('a migrate step that runs too long is rolled back and cleaned up', () =>
    withInstall(async (install) => {
      install.plugins([coins])
      expectExit(await install.start(), 0)
      const files = install.files()
      install.plugins([toy('coins', [text('material')])])
      // migrate:create needs no database. migrate waits on this lock until the step limit kills it.
      const blocker = new pg.Client({ connectionString: install.databaseUrl })
      await blocker.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('LOCK TABLE coins IN ACCESS EXCLUSIVE MODE')
        const stopped = await install.start({ WONDERROOM_STEP_TIMEOUT_MS: '15000' })
        expectExit(stopped, 1)
        expect(stopped.output).toContain(
          `payload migrate did not finish in 15 s. Payload runs each migration in a transaction, so an unfinished one is rolled back. A backup from this start is in ${join(install.dataDir, 'backups')}, if one was taken.`,
        )
        expect(install.files()).toEqual(files)
      } finally {
        await blocker.end()
      }
      expectExit(await install.start(), 0)
      expect(await install.sql(`select count(*)::int as n from information_schema.columns where table_name = 'coins' and column_name = 'material'`)).toEqual([{ n: 1 }])
    }))

  test('two starts at once apply each migration once', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      const [first, second] = await Promise.all([install.start(), install.start()])
      expectExit(first, 0)
      expectExit(second, 0)
      const rows = await install.sql('select name, count(*)::int as n from payload_migrations group by name')
      expect(rows.length).toBe(1)
      expect(rows.every(({ n }) => n === 1)).toBe(true)
    }))
})
