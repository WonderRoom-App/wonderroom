import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import curios from '../../plugin-curios/src'
import { buildEngineConfig, itemTypeSlugs } from '../src/config'
import { coreItemFields } from '../src/coreFields'
import type { Catalog } from '../src/install'
import { findNestedItemReference, itemReference } from '../src/items'
import { StartError, definePlugin } from '../src/plugin'

// Payload appends createdAt and updatedAt to every collection.
const fieldNames = (fields: { name?: string }[]) =>
  fields.map((field) => field.name).filter((name) => name !== 'createdAt' && name !== 'updatedAt')

const itemType = (name: string, ownFields: string[]) => () =>
  definePlugin({
    name,
    kind: 'item-type',
    itemType: {
      slug: name,
      labels: { singular: name, plural: `${name}s` },
      fields: ownFields.map((ownName) => ({ name: ownName, type: 'text' as const })),
    },
  })

const catalog: Catalog = {
  curios,
  alpha: itemType('alpha', ['material']),
  beta: itemType('beta', ['material']),
  clash: itemType('clash', ['title']),
  extras: () => definePlugin({ name: 'extras', kind: 'add-on', collections: [{ slug: 'extras-things', fields: [] }] }),
  nested: () =>
    definePlugin({
      name: 'nested',
      kind: 'add-on',
      collections: [
        {
          slug: 'nested-things',
          fields: [
            {
              type: 'row',
              fields: [
                { name: 'details', type: 'group', fields: [itemReference({ name: 'item', onItemDelete: 'refuse' })] },
              ],
            },
          ],
        },
      ],
    }),
}

function build(pluginsYml: string, siteFiles: Record<string, string> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'wonderroom-'))
  mkdirSync(join(configDir, 'config.d'))
  writeFileSync(join(configDir, 'plugins.yml'), pluginsYml)
  for (const [name, text] of Object.entries(siteFiles)) writeFileSync(join(configDir, 'config.d', name), text)
  return buildEngineConfig({
    catalog,
    configDir,
    dataDir: tmpdir(),
    databaseUrl: 'postgres://localhost/unused',
    secret: 'test-secret',
  })
}

describe('buildEngineConfig', () => {
  it('orders item types first, then users, media, tags, items, then add-ons', async () => {
    const config = await build('plugins:\n  - use: extras\n  - use: beta\n  - use: alpha\n')
    // Payload appends its own payload-* collections.
    expect(config.collections.map((c) => c.slug).filter((slug) => !slug.startsWith('payload-'))).toEqual([
      'beta', 'alpha', 'users', 'media', 'tags', 'items', 'extras-things',
    ])
  })

  it('gives curios every core field, then material and acquiredFrom', async () => {
    const config = await build('plugins:\n  - use: curios\n')
    expect(fieldNames(config.collections[0].fields as { name?: string }[])).toEqual([
      ...fieldNames(coreItemFields as { name?: string }[]),
      'material',
      'acquiredFrom',
    ])
    expect(fieldNames(coreItemFields as { name?: string }[])).toContain('title')
  })

  it('rejects a plugin field that the engine already defines', async () => {
    const attempt = build('plugins:\n  - use: clash\n')
    await expect(attempt).rejects.toThrow(StartError)
    await expect(attempt).rejects.toThrow('clash adds a field named "title", which the engine already defines. Rename the field in the plugin.')
  })

  it('names the collection and its labels from settings', async () => {
    const config = await build('plugins:\n  - use: curios\n    slug: oddities\n    label: Oddity\n    labelPlural: Oddities\n')
    expect(config.collections[0].slug).toBe('oddities')
    expect(config.collections[0].labels).toEqual({ singular: 'Oddity', plural: 'Oddities' })
  })

  it('lists the item type slugs', async () => {
    const config = await build('plugins:\n  - use: curios\n')
    expect(itemTypeSlugs(config)).toEqual(['curios'])
  })
})

describe('item references', () => {
  it('rejects an item reference that is not a top-level field', async () => {
    const attempt = build('plugins:\n  - use: nested\n')
    await expect(attempt).rejects.toThrow(StartError)
    await expect(attempt).rejects.toThrow(
      'nested puts the item reference "item" inside nested-things.details. Item references must be top-level fields in this version. Move the field to the top level.',
    )
  })
  it('finds references in named tabs, arrays and blocks, but not in rows or unnamed tabs', () => {
    const ref = itemReference({ name: 'item', onItemDelete: 'refuse' })
    expect(findNestedItemReference([{ type: 'row', fields: [ref] }])).toBeUndefined()
    expect(findNestedItemReference([{ type: 'tabs', tabs: [{ label: 'One', fields: [ref] }] }])).toBeUndefined()
    expect(findNestedItemReference([{ type: 'tabs', tabs: [{ name: 'one', fields: [ref] }] }])).toEqual({ field: 'item', path: ['one'] })
    expect(findNestedItemReference([{ name: 'rows', type: 'array', fields: [ref] }])).toEqual({ field: 'item', path: ['rows'] })
    expect(
      findNestedItemReference([{ name: 'parts', type: 'blocks', blocks: [{ slug: 'part', fields: [ref] }] }]),
    ).toEqual({ field: 'item', path: ['parts', 'part'] })
  })
})

describe('engine settings', () => {
  const options = (overrides: Record<string, string | undefined>) => ({
    catalog,
    configDir: mkdtempSync(join(tmpdir(), 'wonderroom-')),
    dataDir: tmpdir(),
    databaseUrl: 'postgres://localhost/unused',
    secret: 'test-secret',
    ...overrides,
  })

  it("turns off Payload's telemetry", async () => {
    const opts = options({})
    writeFileSync(join(opts.configDir, 'plugins.yml'), 'plugins: []\n')
    expect((await buildEngineConfig(opts)).telemetry).toBe(false)
  })

  for (const [option, variable] of [['databaseUrl', 'DATABASE_URL'], ['secret', 'PAYLOAD_SECRET']]) {
    it(`stops when ${variable} is missing`, async () => {
      for (const missing of [undefined, '']) {
        const attempt = buildEngineConfig(options({ [option]: missing }))
        await expect(attempt).rejects.toThrow(StartError)
        await expect(attempt).rejects.toThrow(`${variable} is not set. Set it in app/.env. app/.env.example shows what it looks like.`)
      }
    })
  }
})
