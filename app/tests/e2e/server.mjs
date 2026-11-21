// Playwright's web server. Makes the test database, migrates it, runs the dev server, then drops everything.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import pg from 'pg'

const databaseUrl = new URL(process.env.DATABASE_URL)
const databaseName = databaseUrl.pathname.slice(1)
if (!databaseName.startsWith('wonderroom_e2e_')) throw new Error(`Refusing to use database ${databaseName}.`)
// Same guard for the data folder: this script deletes it.
const dataDir = resolve(process.env.WONDERROOM_DATA_DIR)
if (!basename(dataDir).startsWith('wonderroom_e2e_') || basename(dirname(dataDir)) !== '.tmp') {
  throw new Error(`Refusing to use data folder ${dataDir}.`)
}
const serverUrl = new URL(databaseUrl)
serverUrl.pathname = '/postgres'

async function onServer(sql) {
  const client = new pg.Client({ connectionString: serverUrl.toString() })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

await onServer(`CREATE DATABASE ${databaseName}`)
mkdirSync(dataDir, { recursive: true })
const server = spawn('npm run migrate && npm run dev', {
  shell: true,
  detached: true, // its own process group, so stop() can end npm, next and node together
  stdio: 'inherit',
  // The test command loads tsx through NODE_OPTIONS. The app scripts set their own.
  env: { ...process.env, NODE_OPTIONS: '', PLAYWRIGHT_TEST: '' },
})

let stopping = false
async function stop(signalOrCode) {
  if (stopping) return
  stopping = true
  const code = typeof signalOrCode === 'number' ? signalOrCode : 0
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {} // the group is already gone
  await new Promise((resolve) => (server.exitCode === null ? server.once('exit', resolve) : resolve()))
  await onServer(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(code)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
server.on('exit', stop)
