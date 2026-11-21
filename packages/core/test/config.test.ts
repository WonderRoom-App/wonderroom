import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import curios from '../../plugin-curios/src'
import { buildEngineConfig, itemTypeSlugs } from '../src/config'
import { coreItemFields } from '../src/coreFields'
import type { Catalog } from '../src/install'
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
