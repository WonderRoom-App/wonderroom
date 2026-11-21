import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import pg from 'pg'
import { afterEach, describe, expect, test } from 'vitest'
import { coins, curios, type Entry, expectExit, stopStarts, toy, text, withInstall } from './helpers/install'

afterEach(stopStarts)
import { withTestDatabase } from './helpers/db'

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

  test('a start with nothing to change exits on its own', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      expectExit(await install.start(), 0)
      let timer: NodeJS.Timeout | undefined
      const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the second start was still running after 60 s')), 60_000)))
      try {
        expectExit(await Promise.race([install.start(), limit]), 0)
      } finally {
        clearTimeout(timer)
      }
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

  test('when the drop applies and the next migration fails, the drop stays and the next start recovers', () =>
    withInstall(async (install) => {
      const stamps = (material: Entry) => toy('stamps', [material])
      install.plugins([stamps(text('material')), coins])
      expectExit(await install.start(), 0)
      await install.sql(`insert into stamps (title, material) values ('Penny Black', 'paper'), ('Inverted Jenny', 'paper')`)
      await install.sql(`insert into coins (title) values ('Penny')`)
      const before = install.files()
      // Phase 1 drops coins. Phase 2 adds a unique index that the two stamps rows break.
      install.plugins([stamps(text('material', { unique: true }))])
      const line = confirmLine((await install.start()).output, 'drop table coins')
      install.plugins([stamps(text('material', { unique: true }))], [line])
      expectExit(await install.start(), 1)
      expect(await install.tableExists('coins')).toBe(false)
      const kept = install.files().filter((file) => !before.includes(file))
      expect(kept.map((file) => file.replace(/^\d{8}_\d{6}_/, ''))).toEqual(['wonderroom_removals.json', 'wonderroom_removals.ts'])
      const applied = (await install.sql('select name from payload_migrations order by name')).map(({ name }) => name)
      expect(applied).toEqual(install.files().filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)))

      install.plugins([stamps(text('material'))])
      expectExit(await install.start(), 0)
      expect(await install.sql('select title from stamps order by title')).toEqual([{ title: 'Inverted Jenny' }, { title: 'Penny Black' }])
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
        expect(stopped.output).toContain(`The database has no migration history, but ${install.migrationsDir} holds 1 migrations. Check DATABASE_URL. To start over on purpose, empty ${install.migrationsDir} first. If the first start was interrupted, empty ${install.migrationsDir} and start again.`)
      })
      expect(install.files()).toEqual(files)
    }))

  test('a database with another history stops the start and keeps the files', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      expectExit(await install.start(), 0)
      const files = install.files()
      await withTestDatabase(async (otherUrl) => {
        // Install B: its own folder and database, a later migration name and a different schema.
        await withInstall(async (other) => {
          other.plugins([curios, coins])
          expectExit(await other.start({ DATABASE_URL: otherUrl }), 0)
        })
        const stopped = await install.start({ DATABASE_URL: otherUrl })
        expectExit(stopped, 1)
        expect(stopped.output).toMatch(/The database applied \S+, but \S+ has no file for it\. Restore the folder from the backup taken with the database, or check DATABASE_URL\./)
      })
      expect(install.files()).toEqual(files)
    }))

  test('a folder without the latest applied migration stops the start', () =>
    withInstall(async (install) => {
      install.plugins([curios])
      expectExit(await install.start(), 0)
      install.plugins([curios, coins])
      expectExit(await install.start(), 0)
      const latest = install.files().filter((file) => file.endsWith('.json')).at(-1)!.slice(0, -'.json'.length)
      for (const ext of ['ts', 'json']) rmSync(join(install.migrationsDir, `${latest}.${ext}`))
      const stopped = await install.start()
      expectExit(stopped, 1)
      expect(stopped.output).toContain(`The database applied ${latest}, but ${install.migrationsDir} has no file for it.`)
    }))

  test('a confirmed retype backs up the database first', () =>
    withInstall(async (install) => {
      install.plugins([toy('coins', [{ name: 'weight', type: 'number' }])])
      expectExit(await install.start(), 0)
      install.plugins([toy('coins', [text('weight')])])
      const stopped = await install.start()
      expectExit(stopped, 1)
      install.plugins([toy('coins', [text('weight')])], [confirmLine(stopped.output, 'retype coins.weight')])
      expectExit(await install.start(), 0)
      expect(readdirSync(join(install.dataDir, 'backups')).some((file) => file.endsWith('.dump'))).toBe(true)
    }))

  test('a missing pg_dump stops the start before anything is dropped', () =>
    withInstall(async (install) => {
      install.plugins([curios, coins])
      expectExit(await install.start(), 0)
      install.plugins([curios])
      const line = confirmLine((await install.start()).output, 'drop table coins')
      install.plugins([curios], [line])
      const files = install.files()
      const path = process.env.PATH!.split(delimiter).filter((dir) => !existsSync(join(dir, 'pg_dump'))).join(delimiter)
      const stopped = await install.start({ PATH: path })
      expectExit(stopped, 1)
      expect(stopped.output).toContain("can't find pg_dump")
      expect(await install.tableExists('coins')).toBe(true)
      expect(install.files()).toEqual(files)
    }))

  test('a failed backup leaves no dump file', () =>
    withInstall(async (install) => {
      install.plugins([curios, coins])
      expectExit(await install.start(), 0)
      install.plugins([curios])
      const line = confirmLine((await install.start()).output, 'drop table coins')
      install.plugins([curios], [line])
      // A pg_dump that writes part of a file, then fails.
      const bin = join(install.dataDir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'pg_dump'), '#!/bin/sh\nfor arg; do case $arg in --file=*) printf partial > "${arg#--file=}";; esac; done\nexit 1\n', { mode: 0o755 })
      const stopped = await install.start({ PATH: `${bin}${delimiter}${process.env.PATH}` })
      expectExit(stopped, 1)
      expect(stopped.output).toContain('the database backup failed')
      expect(readdirSync(join(install.dataDir, 'backups'))).toEqual([])
      expect(await install.tableExists('coins')).toBe(true)
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
      expect(stopped.output).toMatch(/The database applied \S+, but \S+ has no file for it\./)
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
      // The killed step's backend can outlive it, queued for the lock. A bound makes a stuck start name its step.
      expectExit(await install.start({ WONDERROOM_STEP_TIMEOUT_MS: '60000' }), 0)
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
