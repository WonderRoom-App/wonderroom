import type { PostgresAdapter } from '@payloadcms/db-postgres'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APIError, getPayload, type Payload } from 'payload'
import { describe, expect, it } from 'vitest'
import { buildEngineConfig } from '../src/config'
import { rebuildItemsIndex } from '../src/items'
import { catalog } from './fixtures/catalog'
import { withTestDatabase } from './helpers/db'

const refusal = 'This curio has 1 ledger entry. Delete or move them first.'

/** Runs `fn` with a Payload whose schema Payload pushes into a fresh test database. */
function withPayload(fn: (payload: Payload) => Promise<void>) {
  return withTestDatabase(async (databaseUrl) => {
    const configDir = mkdtempSync(join(tmpdir(), 'wonderroom-'))
    writeFileSync(join(configDir, 'plugins.yml'), 'plugins:\n  - use: curios\n  - use: featured\n  - use: ledger\n')
    const config = await buildEngineConfig({
      catalog,
      configDir,
      dataDir: mkdtempSync(join(tmpdir(), 'wonderroom-data-')),
      databaseUrl,
      secret: 'test-secret',
    })
    // Tests only: the engine itself never pushes. Payload skips a push when the
    // schema matches its last push in this process, so force one per database.
    process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
    const init = config.db.init
    config.db.init = (args) => Object.assign(init(args), { push: true })
    const payload = await getPayload({ config, key: databaseUrl })
    try {
      await fn(payload)
    } finally {
      // destroy() leaves the pool open, and an open pool blocks the drop.
      await payload.destroy()
      await (payload.db as unknown as PostgresAdapter).pool.end()
    }
  })
}

const indexRows = async (payload: Payload) =>
  (await payload.find({ collection: 'items', pagination: false, sort: 'itemId' })).docs

const indexRowFor = async (payload: Payload, itemId: number | string) =>
  (await payload.find({ collection: 'items', where: { itemType: { equals: 'curios' }, itemId: { equals: itemId } } }))
    .docs[0]

const count = async (payload: Payload, collection: string) => (await payload.count({ collection })).totalDocs

const rawQuery = (payload: Payload, text: string, values: unknown[]) =>
  (payload.db as unknown as PostgresAdapter).pool.query(text, values)

describe('the items index', { timeout: 60_000 }, () => {
  it('follows a curio through create, rename and delete', () =>
    withPayload(async (payload) => {
      const curio = await payload.create({ collection: 'curios', data: { title: 'Brass key' } })
      expect(await indexRows(payload)).toMatchObject([{ itemType: 'curios', itemId: curio.id, title: 'Brass key (Curio)' }])

      await payload.update({ collection: 'curios', id: curio.id, data: { title: 'Iron key' } })
      expect(await indexRows(payload)).toMatchObject([{ itemType: 'curios', itemId: curio.id, title: 'Iron key (Curio)' }])

      await payload.delete({ collection: 'curios', id: curio.id })
      expect(await indexRows(payload)).toEqual([])
    }))

  it('links a featured entry to a curio through its index row, and to nothing else', () =>
    withPayload(async (payload) => {
      const curio = await payload.create({ collection: 'curios', data: { title: 'Brass key' } })
      const row = await indexRowFor(payload, curio.id)
      const entry = await payload.create({ collection: 'featured', data: { item: row.id }, depth: 1 })
      expect(entry.item).toMatchObject({ itemType: 'curios', itemId: curio.id })

      await expect(payload.create({ collection: 'featured', data: { item: 9999 } })).rejects.toThrow()
      expect(await count(payload, 'featured')).toBe(1)
    }))

  it('removes the featured entry when its curio is deleted', () =>
    withPayload(async (payload) => {
      const curio = await payload.create({ collection: 'curios', data: { title: 'Brass key' } })
      const row = await indexRowFor(payload, curio.id)
      await payload.create({ collection: 'featured', data: { item: row.id } })

      await payload.delete({ collection: 'curios', id: curio.id })
      expect(await count(payload, 'curios')).toBe(0)
      expect(await count(payload, 'featured')).toBe(0)
      expect(await count(payload, 'items')).toBe(0)
    }))

  it('refuses to delete a curio that a ledger entry points at', () =>
    withPayload(async (payload) => {
      const curio = await payload.create({ collection: 'curios', data: { title: 'Brass key' } })
      const row = await indexRowFor(payload, curio.id)
      await payload.create({ collection: 'ledger', data: { item: row.id } })

      const attempt = payload.delete({ collection: 'curios', id: curio.id })
      await expect(attempt).rejects.toBeInstanceOf(APIError)
      await expect(attempt).rejects.toThrow(refusal)
      expect(await count(payload, 'curios')).toBe(1)
      expect(await count(payload, 'items')).toBe(1)
      expect(await count(payload, 'ledger')).toBe(1)

      await payload.create({ collection: 'ledger', data: { item: row.id } })
      await expect(payload.delete({ collection: 'curios', id: curio.id })).rejects.toThrow(
        'This curio has 2 ledger entries. Delete or move them first.',
      )
    }))

  it('applies the delete rules to each curio in a bulk delete', () =>
    withPayload(async (payload) => {
      const free = await payload.create({ collection: 'curios', data: { title: 'Free' } })
      const held = await payload.create({ collection: 'curios', data: { title: 'Held' } })
      await payload.create({ collection: 'featured', data: { item: (await indexRowFor(payload, free.id)).id } })
      await payload.create({ collection: 'ledger', data: { item: (await indexRowFor(payload, held.id)).id } })

      // Payload 3.94.1 reports a refused document in `errors`; it does not throw.
      const result = await payload.delete({ collection: 'curios', where: { id: { in: [free.id, held.id] } } })
      expect(result.docs.map((doc) => doc.id)).toEqual([free.id])
      expect(result.errors).toMatchObject([{ id: held.id, message: refusal }])

      expect((await payload.find({ collection: 'curios' })).docs.map((doc) => doc.id)).toEqual([held.id])
      expect(await indexRows(payload)).toMatchObject([{ itemId: held.id }])
      expect(await count(payload, 'featured')).toBe(0)
      expect(await count(payload, 'ledger')).toBe(1)
    }))

  it('rebuilds the index after writes that skip Payload', () =>
    withPayload(async (payload) => {
      const kept = await payload.create({ collection: 'curios', data: { title: 'Kept' } })
      const gone = await payload.create({ collection: 'curios', data: { title: 'Gone' } })
      const held = await payload.create({ collection: 'curios', data: { title: 'Held' } })
      await payload.create({ collection: 'ledger', data: { item: (await indexRowFor(payload, held.id)).id } })

      const { rows } = await rawQuery(payload, 'INSERT INTO curios (title) VALUES ($1) RETURNING id', ['Raw'])
      await rawQuery(payload, 'DELETE FROM curios WHERE id = ANY($1)', [[gone.id, held.id]])
      await rawQuery(payload, 'UPDATE curios SET title = $1 WHERE id = $2', ['Renamed', kept.id])

      // Held's row stays: a ledger entry still points at it.
      expect(await rebuildItemsIndex(payload)).toEqual({ created: 1, removed: 1, retitled: 1 })
      expect(await indexRows(payload)).toMatchObject([
        { itemId: kept.id, title: 'Renamed (Curio)' },
        { itemId: held.id, title: 'Held (Curio)' },
        { itemId: rows[0].id, title: 'Raw (Curio)' },
      ])
      expect(await rebuildItemsIndex(payload)).toEqual({ created: 0, removed: 0, retitled: 0 })
    }))
})
