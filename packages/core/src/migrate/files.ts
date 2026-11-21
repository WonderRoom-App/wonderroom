import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeMigrationIndex } from 'payload'
import type { Snapshot } from './analyze'

const isMigrationFile = (file: string) => /\.(ts|js|json)$/.test(file) && !/^index\.(ts|js)$/.test(file)

/** Names of the migrations in the folder (file names without the extension), sorted. */
export function migrationNames(dir: string): string[] {
  const names = readdirSync(dir).filter(isMigrationFile).map((file) => file.split('.')[0])
  return [...new Set(names)].sort()
}

/** Deletes the files of every migration the database has not applied, then rewrites index.ts. */
export function deleteUnapplied(dir: string, applied: Set<string>): string[] {
  const deleted = readdirSync(dir).filter((file) => isMigrationFile(file) && !applied.has(file.split('.')[0]))
  for (const file of deleted) rmSync(join(dir, file))
  writeMigrationIndex({ migrationsDir: dir })
  return deleted
}

/** The newest snapshot, as `migrate:create` picks it: the last `.json` by name. */
export function latestSnapshot(dir: string): { name: string; snapshot: Snapshot } | null {
  const file = readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort().at(-1)
  if (file === undefined) return null
  return { name: file.slice(0, -'.json'.length), snapshot: JSON.parse(readFileSync(join(dir, file), 'utf8')) }
}

// The same text Payload's db-postgres adapter writes (sanitizeStatements and getMigrationTemplate in 3.94.1).
const indent = (text: string) => text.split('\n').map((line) => `  ${line}`).join('\n')
const execute = (statements: string[]) =>
  statements.length ? `await db.execute(sql\`\n ${statements.join('\n')}\`)` : '  // Migration code'

/** Writes `<name>.ts` and `<name>.json` the way `payload migrate:create` does, then rewrites index.ts. */
export function writeMigration(
  dir: string,
  name: string,
  migration: { packageName: string; up: string[]; down: string[]; snapshot: Snapshot },
): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(migration.snapshot, null, 2))
  writeFileSync(
    join(dir, `${name}.ts`),
    `import { MigrateUpArgs, MigrateDownArgs, sql } from '${migration.packageName}'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
${indent(execute(migration.up))}
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
${indent(execute(migration.down))}
}
`,
  )
  writeMigrationIndex({ migrationsDir: dir })
}
