import type { PostgresAdapter } from '@payloadcms/db-postgres'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { Payload } from 'payload'
import { escapeIdentifier } from 'pg'
import { rebuildItemsIndex } from '../items'
import { StartError } from '../plugin'
import { analyzeSchemaChange, planMigration, removalMigration, type SchemaChange, type Snapshot } from './analyze'
import { deleteUnapplied, latestSnapshot, migrationNames, writeMigration } from './files'

type Query = (text: string) => Promise<{ rows: any[] }>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Payload's migration name timestamp: UTC, to the second. */
const timestamp = () => {
  const [day, time] = new Date().toISOString().split('T')
  return `${day.replace(/\D/g, '')}_${time.split('.')[0].replace(/\D/g, '')}`
}

/**
 * Runs one CLI step as a child process, with no stdin and a time limit. Its output goes to ours.
 * Resolves once the child has exited, so a killed step can't write files after the caller cleans up.
 */
function runStep(step: string, command: string, args: string[], afterTimeout = 'It may be waiting for an answer to a question. Nothing was applied.'): Promise<void> {
  const limitMs = Number(process.env.WONDERROOM_STEP_TIMEOUT_MS ?? 300_000)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const keep = (chunk: Buffer, to: NodeJS.WriteStream) => {
      to.write(chunk)
      output += chunk
    }
    child.stdout.on('data', (chunk) => keep(chunk, process.stdout))
    child.stderr.on('data', (chunk) => keep(chunk, process.stderr))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, limitMs)
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(
        error.code === 'ENOENT'
          ? new StartError(`The engine can't find ${command}, which it needs for ${step}. Install it and start again.`)
          : error,
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new StartError(`${step} did not finish in ${limitMs / 1000} s. ${afterTimeout}`))
      } else if (code !== 0) {
        const tail = stripVTControlCharacters(output).trim().split('\n').slice(-20).join('\n')
        reject(new StartError(`${step} failed. Fix the problem it names, then start again. It said:\n${tail}`))
      } else {
        resolve()
      }
    })
  })
}

async function appliedMigrations(query: Query): Promise<{ name: string; batch: string }[]> {
  const { rows } = await query(`select to_regclass('payload_migrations') is not null as found`)
  if (!rows[0].found) return []
  return (await query('select name, batch from payload_migrations')).rows
}

/** Tables that get a NOT NULL column and already hold rows. Child and array tables count too. */
async function tablesWithRows(query: Query, change: SchemaChange): Promise<Set<string>> {
  const tables = new Set([...change.addedColumns.filter((added) => added.notNull), ...change.newlyNotNull].map(({ table }) => table))
  const withRows = new Set<string>()
  for (const table of tables) {
    const { rows } = await query(`select exists (select 1 from ${escapeIdentifier(table)}) as found`)
    if (rows[0].found) withRows.add(table)
  }
  return withRows
}

const columnType = (snapshot: Snapshot, table: string, column: string): string | undefined =>
  Object.values<any>(snapshot.tables).find((entry) => entry.name === table)?.columns[column]?.type

/**
 * The statements in a generated migration's `up` that can lose data, minus the ones the owner confirmed
 * or the plan already checked. Phase 1 carried out the removals, so a DROP TABLE or DROP COLUMN here is never covered.
 */
function uncoveredStatements(file: string, input: { before: Snapshot; change: SchemaChange; confirm: string[]; latest: string | null }): string[] {
  const { before, change, confirm, latest } = input
  const confirmed = (action: string) => latest !== null && confirm.includes(`${action} @ ${latest}`)
  const text = readFileSync(file, 'utf8')
  // The SQL inside up's sql`...` call. The `down` function follows it.
  const up = text.slice(text.indexOf('export async function up'), text.indexOf('export async function down')).match(/sql`([\s\S]*)`\)/)?.[1] ?? ''
  // Enums whose removed values the owner confirmed. Drizzle rebuilds such an enum with DROP TYPE and SET DATA TYPE.
  const rebuiltEnums = change.changedEnums
    .filter(({ enum: name, removedValues }) => removedValues.length && confirmed(`drop values ${name}.${removedValues.join(',')}`))
    .map(({ enum: name }) => name)
  const isCovered = (statement: string) => {
    const column = statement.match(/ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" (SET DATA TYPE|SET NOT NULL)/)
    if (column) {
      const [, table, name, action] = column
      if (action === 'SET NOT NULL') return change.newlyNotNull.some((entry) => entry.table === table && entry.column === name)
      return confirmed(`retype ${table}.${name}`) || rebuiltEnums.includes(columnType(before, table, name) ?? '')
    }
    const type = statement.match(/DROP TYPE (?:"[^"]+"\.)?"([^"]+)"/)
    if (type) {
      const enumName = type[1]
      if (rebuiltEnums.includes(enumName)) return true
      // A removed enum reaches phase 2 only when confirmed retypes free every column that used it.
      return change.retypedColumns.some(({ table, column, from }) => from === enumName && confirmed(`retype ${table}.${column}`))
    }
    return false // DROP TABLE, DROP COLUMN
  }
  return up
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => /DROP TABLE|DROP COLUMN|DROP TYPE|SET DATA TYPE|SET NOT NULL/.test(statement))
    .filter((statement) => !isCovered(statement))
}

export async function runMigrations(payload: Payload, options: { dataDir: string; confirm: string[] }): Promise<void> {
  const db = payload.db as unknown as PostgresAdapter
  const query: Query = (text) => db.pool.query(text)
  const dir = join(options.dataDir, 'migrations')
  mkdirSync(dir, { recursive: true })

  const applied = await appliedMigrations(query)
  if (applied.some(({ batch }) => Number(batch) === -1)) { // pg returns numeric as text
    throw new StartError(
      "Table payload_migrations has a row with batch -1. Payload's dev push changed this database, so the migration files no longer describe it. Restore a backup, or reset the database.",
    )
  }
  const appliedNames = new Set(applied.map(({ name }) => name))
  const folderNames = migrationNames(dir)
  if (!applied.length && folderNames.length) {
    throw new StartError(
      `The database has no migration history, but ${dir} holds ${folderNames.length} migrations. Check DATABASE_URL. To start over on purpose, empty ${dir} first.`,
    )
  }
  const latestApplied = [...appliedNames].sort().at(-1) ?? ''
  const olderUnapplied = folderNames.filter((name) => name < latestApplied && !appliedNames.has(name))
  if (olderUnapplied.length) {
    throw new StartError(
      `${dir} holds migrations older than the database's latest one that the database never applied: ${olderUnapplied.join(', ')}. Restore the folder from the backup taken with the database.`,
    )
  }
  // A start that died halfway leaves files the database never applied. They are not to be trusted.
  for (const file of deleteUnapplied(dir, appliedNames)) console.log(`Deleted ${file}, which the database never applied.`)

  const latest = latestSnapshot(dir)
  if (latest === null && applied.length) {
    throw new StartError(
      `The migrations folder ${dir} is missing or empty, but the database has applied migrations. Restore the folder from the backup taken with the database.`,
    )
  }

  const { generateDrizzleJson, generateMigration, upSnapshot } = db.requireDrizzleKit()
  const after = (await generateDrizzleJson(db.schema)) as unknown as Snapshot
  let before = (latest?.snapshot ?? db.defaultDrizzleSnapshot) as Snapshot
  if (upSnapshot && Number(before.version) < Number(after.version)) before = upSnapshot(before) as unknown as Snapshot
  const latestName = latest?.name ?? null
  const change = analyzeSchemaChange(before, after)
  const plan = planMigration(change, { before, confirm: options.confirm, latestMigration: latestName, tablesWithRows: await tablesWithRows(query, change) })
  if (plan.kind === 'stop') throw new StartError(plan.message)

  const backups = join(options.dataDir, 'backups')
  try {
    let reduced = before
    if (plan.kind === 'apply' && plan.removals.length) {
      mkdirSync(backups, { recursive: true })
      const dump = join(backups, `before-${timestamp()}.dump`)
      await runStep('pg_dump', 'pg_dump', ['--format=custom', `--file=${dump}`, `--dbname=${db.poolOptions.connectionString}`])
      console.log(`Backed up the database to ${dump}.`)

      const phaseOne = await removalMigration(before, plan.removals, generateMigration)
      const down = await generateMigration(phaseOne.snapshot as any, before as any)
      writeMigration(dir, `${timestamp()}_wonderroom_removals`, { packageName: db.packageName, up: phaseOne.statements, down, snapshot: phaseOne.snapshot })
      reduced = phaseOne.snapshot
      // ponytail: one-second wait orders the two files; use a counter suffix if starts get busy
      await sleep(1000 - (Date.now() % 1000))
    }

    if ((await generateMigration(reduced as any, after as any)).length) {
      const known = new Set(migrationNames(dir))
      await runStep('payload migrate:create', 'payload', ['migrate:create', 'wonderroom', '--skip-empty'])
      const [created] = migrationNames(dir).filter((name) => !known.has(name))
      if (created === undefined) {
        throw new StartError(
          `payload migrate:create exited without writing a migration to ${dir}, but the schema has changes. It may have stopped at a question it could not ask. Nothing was applied.`,
        )
      }
      const uncovered = uncoveredStatements(join(dir, `${created}.ts`), { before, change, confirm: options.confirm, latest: latestName })
      if (uncovered.length) {
        throw new StartError(
          `Migration ${created} would run statements that can lose data, and no confirmed line covers them. Nothing was applied:\n${uncovered.join('\n')}`,
        )
      }
    }

    if (migrationNames(dir).some((name) => !appliedNames.has(name))) await runStep('payload migrate', 'payload', ['migrate'], `Payload runs each migration in a transaction, so an unfinished one is rolled back. A backup from this start is in ${backups}, if one was taken.`)
  } catch (error) {
    // The database is the record of what happened. Files it did not apply must not survive to the next start.
    const nowApplied = new Set((await appliedMigrations(query)).map(({ name }) => name))
    for (const file of deleteUnapplied(dir, nowApplied)) console.log(`Deleted ${file}, which the database did not apply.`)
    throw error
  }

  const counts = await rebuildItemsIndex(payload)
  if (counts.created || counts.removed || counts.retitled) {
    console.log(`Items index: ${counts.created} created, ${counts.removed} removed, ${counts.retitled} retitled.`)
  }
}
