import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { expect } from 'vitest'
import { stringify } from 'yaml'
import { withTestDatabase } from './db'

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const fixtureConfig = fileURLToPath(new URL('../fixtures/payload.config.ts', import.meta.url))
// Not the system temp folder: migration files import @payloadcms/db-postgres, so the data
// folder must sit where Node can find node_modules.
const tmpRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url))

export type Entry = Record<string, unknown>
export const curios: Entry = { use: 'curios' }
export const toy = (slug: string, extraFields?: Entry[]): Entry => ({ use: 'toy-item', slug, ...(extraFields && { extraFields }) })
export const coins = toy('coins')
export const text = (name: string, more: Entry = {}): Entry => ({ name, type: 'text', ...more })

export type Start = { code: number | null; output: string }

const running = new Set<ChildProcess>()

/**
 * Kills every start still running. Use it in afterEach: a test that times out leaves its start running.
 * Once the start dies, the test's own cleanup runs and drops its database.
 */
export function stopStarts() {
  for (const child of running) {
    try {
      process.kill(-child.pid!, 'SIGKILL') // the start runs as its own process group
    } catch {} // the group is already gone
  }
}

/** One install: a config folder, a data folder and a test database, started with `npm run migrate -w app`. */
export function withInstall(fn: (install: ReturnType<typeof makeInstall>) => Promise<void>) {
  return withTestDatabase(async (databaseUrl) => {
    mkdirSync(tmpRoot, { recursive: true })
    const root = mkdtempSync(join(tmpRoot, 'install-'))
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
          detached: true, // its own process group, so cleanup ends npm and payload together
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
        running.add(child)
        let output = ''
        child.stdout.on('data', (chunk) => (output += chunk))
        child.stderr.on('data', (chunk) => (output += chunk))
        child.on('error', reject)
        child.on('close', (code) => {
          running.delete(child)
          resolve({ code, output })
        })
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

export const expectExit = (start: Start, code: number) => expect(start.code, start.output).toBe(code)

