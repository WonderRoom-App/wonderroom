import type { Field } from 'payload'
import curios from '../../../plugin-curios/src'
import type { Catalog } from '../../src/install'
import { itemReference } from '../../src/items'
import { definePlugin } from '../../src/plugin'

/** A bare item type for tests that need more than one. */
export const toyItem = (settings: { slug: string; extraFields?: Field[] }) =>
  definePlugin({
    name: settings.slug,
    kind: 'item-type',
    itemType: {
      slug: settings.slug,
      labels: { singular: settings.slug, plural: `${settings.slug}s` },
      fields: settings.extraFields ?? [],
    },
  })

/** Featured entries go away with their item. */
export const toyFeatured = definePlugin({
  name: 'featured',
  kind: 'add-on',
  collections: [
    {
      slug: 'featured',
      fields: [itemReference({ name: 'item', required: true, onItemDelete: 'remove-entry' })],
    },
  ],
})

/** Ledger entries keep their item from being deleted. */
export const toyLedger = definePlugin({
  name: 'ledger',
  kind: 'add-on',
  collections: [
    {
      slug: 'ledger',
      labels: { singular: 'Ledger entry', plural: 'Ledger entries' },
      fields: [itemReference({ name: 'item', required: true, onItemDelete: 'refuse' })],
    },
  ],
})

export const catalog: Catalog = {
  curios,
  // plugins.yml: `use: toy-item` with `slug:` and optional `extraFields:`.
  'toy-item': (settings) => toyItem(settings as Parameters<typeof toyItem>[0]),
  featured: () => toyFeatured,
  ledger: () => toyLedger,
}
