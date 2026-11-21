import { randomBytes } from 'node:crypto'
import pg from 'pg'

const serverUrl = 'postgres://postgres:postgres@localhost:5433/postgres'

/**
 * Creates a database with a random name, runs `fn` against it, then drops it.
 * The drop forces off any connection left open, such as a start that outlived its test.
 * It never touches a database it did not create.
 */
export async function withTestDatabase<T>(fn: (databaseUrl: string) => Promise<T>): Promise<T> {
  const name = `wonderroom_test_${randomBytes(6).toString('hex')}`
  const server = new pg.Client({ connectionString: serverUrl })
  await server.connect()
  try {
    await server.query(`CREATE DATABASE ${name}`)
    try {
      const url = new URL(serverUrl)
      url.pathname = `/${name}`
      return await fn(url.toString())
    } finally {
      await server.query(`DROP DATABASE ${name} WITH (FORCE)`)
    }
  } finally {
    await server.end()
  }
}
