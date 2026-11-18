// Toy plugins for the migrations test build. Throwaway.
import type { CollectionConfig, Field } from 'payload'

export type Plugin = {
  name: string
  itemTypeSlug?: string
  collections: (ctx: { itemSlugs: string[]; loaded: Set<string> }) => CollectionConfig[]
}

// WR_RIBBON_NAME lets Task 2 Step 3 rename the field without editing code.
const ribbonName = process.env.WR_RIBBON_NAME || 'ribbonSize'

export const itemType = (slug: string): Plugin => ({
  name: slug,
  itemTypeSlug: slug,
  collections: ({ loaded }) => {
    const fields: Field[] = [
      { name: 'title', type: 'text', required: true },
      { name: 'yearFrom', type: 'number' },
    ]
    if (slug.startsWith('typewriters') || slug.startsWith('office')) {
      fields.push({ name: ribbonName, type: 'text' })
    }
    if (loaded.has('makers')) {
      fields.push({ name: 'manufacturer', type: 'relationship', relationTo: 'manufacturers' })
    }
    return [{ slug, fields }]
  },
})

export const makers: Plugin = {
  name: 'makers',
  collections: () => [{ slug: 'manufacturers', fields: [{ name: 'name', type: 'text', required: true }] }],
}

export const featured: Plugin = {
  name: 'featured',
  collections: ({ itemSlugs }) => [
    {
      slug: 'featured',
      fields: [{ name: 'machine', type: 'relationship', relationTo: itemSlugs, required: true }],
    },
  ],
}

const ADD_ONS: Record<string, Plugin> = { makers, featured }

// Any name that is not an add-on is treated as an item type with that slug.
export const resolve = (name: string): Plugin => ADD_ONS[name] ?? itemType(name)
