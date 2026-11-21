// Playwright's web server. Makes the test database, migrates it, runs the dev server, then drops everything.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import pg from 'pg'

const databaseUrl = new URL(process.env.DATABASE_URL)
const databaseName = databaseUrl.pathname.slice(1)
if (!databaseName.startsWith('wonderroom_e2e_')) throw new Error(`Refusing to use database ${databaseName}.`)
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
mkdirSync(process.env.WONDERROOM_DATA_DIR, { recursive: true })
const server = spawn('npm run migrate && npm run dev', {
  shell: true,
  stdio: 'inherit',
  // The test command loads tsx through NODE_OPTIONS. The app scripts set their own.
  env: { ...process.env, NODE_OPTIONS: '', PLAYWRIGHT_TEST: '' },
})

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  server.kill('SIGTERM')
  await new Promise((resolve) => (server.exitCode === null ? server.once('exit', resolve) : resolve()))
  await onServer(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
  rmSync(process.env.WONDERROOM_DATA_DIR, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
server.on('exit', stop)
