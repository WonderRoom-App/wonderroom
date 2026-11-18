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
    return [{ slug, fields, hooks: REF_MODE === 'index' ? indexHooks(slug) : undefined }]
  },
})

// Item reference spike: how Featured points at "any item".
//   poly  = Payload's polymorphic relationship (M0, a column per item type)
//   pair  = two plain fields, itemType + itemId (Rails / Django style, no foreign key)
//   index = a relationship to an engine-owned `items` table, kept in step by hooks
const REF_MODE = process.env.WR_REF || 'poly'

// The index row carries the title, because the admin picker shows `useAsTitle`.
const indexHooks = (slug: string): CollectionConfig['hooks'] => ({
  afterChange: [
    async ({ doc, operation, req }) => {
      const found = await req.payload.find({
        collection: 'items' as any, req, limit: 1,
        where: { itemType: { equals: slug }, itemId: { equals: doc.id } },
      })
      if (operation === 'create' || found.docs.length === 0) {
        await req.payload.create({
          collection: 'items' as any, req,
          data: { itemType: slug, itemId: doc.id, title: doc.title },
        })
      } else if (found.docs[0].title !== doc.title) {
        await req.payload.update({
          collection: 'items' as any, req, id: found.docs[0].id, data: { title: doc.title },
        })
      }
    },
  ],
  afterDelete: [
    async ({ doc, req }) => {
      await req.payload.delete({
        collection: 'items' as any, req,
        where: { itemType: { equals: slug }, itemId: { equals: doc.id } },
      })
    },
  ],
})

export const itemsIndex: Plugin = {
  name: 'items',
  collections: () => [
    {
      slug: 'items',
      admin: { useAsTitle: 'title' },
      fields: [
        { name: 'itemType', type: 'text', required: true, index: true },
        { name: 'itemId', type: 'number', required: true, index: true },
        { name: 'title', type: 'text' },
      ],
    },
  ],
}

const machineField = (itemSlugs: string[]): Field[] => {
  if (REF_MODE === 'pair') {
    return [
      {
        name: 'itemType', type: 'text', required: true,
        validate: (v: unknown) => itemSlugs.includes(String(v)) || `unknown item type ${v}`,
      },
      { name: 'itemId', type: 'number', required: true },
    ]
  }
  if (REF_MODE === 'index') {
    return [{ name: 'machine', type: 'relationship', relationTo: 'items', required: true }]
  }
  return [{ name: 'machine', type: 'relationship', relationTo: itemSlugs, required: true }]
}

export const makers: Plugin = {
  name: 'makers',
  collections: () => [{ slug: 'manufacturers', fields: [{ name: 'name', type: 'text', required: true }] }],
}

export const featured: Plugin = {
  name: 'featured',
  collections: ({ itemSlugs }) => [
    {
      slug: 'featured',
      fields: machineField(itemSlugs),
    },
  ],
}

const ADD_ONS: Record<string, Plugin> = { makers, featured, items: itemsIndex }

// Any name that is not an add-on is treated as an item type with that slug.
export const resolve = (name: string): Plugin => ADD_ONS[name] ?? itemType(name)
