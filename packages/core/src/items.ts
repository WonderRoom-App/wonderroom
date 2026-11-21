import {
  APIError,
  type CollectionAfterChangeHook,
  type CollectionAfterDeleteHook,
  type CollectionBeforeDeleteHook,
  type CollectionConfig,
  type Field,
  type Payload,
  type PayloadRequest,
  type SanitizedCollectionConfig,
  type SanitizedConfig,
} from 'payload'
import { itemTypeSlugs } from './config'

export type OnItemDelete = 'remove-entry' | 'refuse'

/** A field, somewhere in the config, that points at the items index. */
export type ItemReferenceUse = { collection: string; field: string; onItemDelete: OnItemDelete }

type IndexRow = { id: number | string; itemType: string; itemId: number; title?: string | null }

/**
 * One row per item of every item type. "Any item" references point here, so they get a
 * real foreign key. Row ids are not item ids: never show one in a URL.
 */
export const itemsCollection: CollectionConfig = {
  slug: 'items',
  admin: { useAsTitle: 'title' },
  // Only the engine's hooks and rebuild write here, through the Local API's overrideAccess.
  access: {
    read: ({ req }) => Boolean(req.user),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  indexes: [{ fields: ['itemType', 'itemId'], unique: true }],
  fields: [
    { name: 'itemType', type: 'text', required: true, index: true },
    { name: 'itemId', type: 'number', required: true, index: true },
    { name: 'title', type: 'text' },
  ],
}

/** A reference to any item. `onItemDelete` says what happens when that item is deleted. */
export function itemReference(options: {
  name: string
  label?: string
  required?: boolean
  onItemDelete: OnItemDelete
}): Field {
  return {
    name: options.name,
    label: options.label,
    required: options.required,
    type: 'relationship',
    relationTo: itemsCollection.slug,
    custom: { wonderroom: { onItemDelete: options.onItemDelete } },
  }
}

const isItemReference = (field: Field) => Boolean(field.custom?.wonderroom?.onItemDelete)

/**
 * Finds an item reference below the top level of `fields`. Rows, collapsibles, unnamed
 * groups and unnamed tabs keep their fields at the top level; named groups, named tabs,
 * arrays and blocks do not. Returns the field name and the path of its container.
 */
export function findNestedItemReference(fields: Field[], path: string[] = []): { field: string; path: string[] } | undefined {
  for (const field of fields) {
    if (path.length > 0 && 'name' in field && isItemReference(field)) return { field: field.name, path }
    for (const [childFields, childPath] of childFieldLists(field, path)) {
      const found = findNestedItemReference(childFields, childPath)
      if (found) return found
    }
  }
  return undefined
}

function childFieldLists(field: Field, path: string[]): [Field[], string[]][] {
  const named = 'name' in field && field.name ? [...path, field.name] : path
  if (field.type === 'tabs') return field.tabs.map((tab) => [tab.fields, 'name' in tab && tab.name ? [...path, tab.name] : path])
  if (field.type === 'blocks') return field.blocks.map((block) => [block.fields, [...named, block.slug]])
  if ('fields' in field) return [[field.fields, named]]
  return []
}

// buildEngineConfig rejects nested references first, so the top level holds them all.
export function findItemReferences(collections: SanitizedCollectionConfig[]): ItemReferenceUse[] {
  return collections.flatMap((collection) =>
    collection.flattenedFields.flatMap((field) => {
      const onItemDelete = field.custom?.wonderroom?.onItemDelete
      return onItemDelete ? [{ collection: collection.slug, field: field.name, onItemDelete }] : []
    }),
  )
}

const itemReferences = (config: SanitizedConfig): ItemReferenceUse[] => config.custom.wonderroom.itemReferences

// ponytail: plain-text labels only; a translated or function label falls back to the slug.
const labelText = (label: unknown, slug: string) => (typeof label === 'string' ? label : slug)

const indexTitle = (title: string, itemType: SanitizedCollectionConfig) =>
  `${title} (${labelText(itemType.labels.singular, itemType.slug)})`

async function findIndexRow(payload: Payload, itemType: string, itemId: number | string, req?: PayloadRequest) {
  const { docs } = await payload.find({
    collection: itemsCollection.slug,
    where: { itemType: { equals: itemType }, itemId: { equals: itemId } },
    limit: 1,
    depth: 0,
    req,
  })
  return docs[0] as IndexRow | undefined
}

const countReferences = async (payload: Payload, use: ItemReferenceUse, rowId: IndexRow['id'], req?: PayloadRequest) =>
  (await payload.count({ collection: use.collection, where: { [use.field]: { equals: rowId } }, req })).totalDocs

/** Item type afterChange: create the item's index row, or retitle it. */
export const syncIndexRow: CollectionAfterChangeHook = async ({ collection, doc, req }) => {
  const title = indexTitle(doc.title, collection)
  const row = await findIndexRow(req.payload, collection.slug, doc.id, req)
  if (!row) {
    await req.payload.create({
      collection: itemsCollection.slug,
      data: { itemType: collection.slug, itemId: doc.id, title },
      req,
    })
  } else if (row.title !== title) {
    await req.payload.update({ collection: itemsCollection.slug, id: row.id, data: { title }, req })
  }
  return doc
}

/**
 * Item type beforeDelete: apply each reference's rule before the database sees the delete.
 * Every refusal is checked before anything is removed.
 */
export const applyDeleteRules: CollectionBeforeDeleteHook = async ({ collection, id, req }) => {
  const row = await findIndexRow(req.payload, collection.slug, id, req)
  if (!row) return

  const used: { use: ItemReferenceUse; count: number }[] = []
  for (const use of itemReferences(req.payload.config)) {
    const count = await countReferences(req.payload, use, row.id, req)
    if (count > 0) used.push({ use, count })
  }

  const refusals = used.filter(({ use }) => use.onItemDelete === 'refuse')
  if (refusals.length > 0) {
    const holders = refusals.map(({ use, count }) => {
      const { labels } = req.payload.collections[use.collection].config
      const label = labelText(count === 1 ? labels.singular : labels.plural, use.collection)
      return `${count} ${label.toLowerCase()}`
    })
    const itemLabel = labelText(collection.labels.singular, collection.slug).toLowerCase()
    throw new APIError(`This ${itemLabel} has ${holders.join(' and ')}. Delete or move them first.`, 409)
  }

  for (const { use } of used) {
    const { errors } = await req.payload.delete({
      collection: use.collection,
      where: { [use.field]: { equals: row.id } },
      depth: 0,
      req,
    })
    if (errors.length > 0) throw new APIError(errors[0].message, 409)
  }
}

/** Item type afterDelete: remove the item's index row. */
export const removeIndexRow: CollectionAfterDeleteHook = async ({ collection, id, req }) => {
  const { errors } = await req.payload.delete({
    collection: itemsCollection.slug,
    where: { itemType: { equals: collection.slug }, itemId: { equals: id } },
    depth: 0,
    req,
  })
  if (errors.length > 0) throw new APIError(errors[0].message, 409)
}

/**
 * Brings the index in step with the item tables after writes that skipped Payload,
 * such as raw SQL or a restore. An orphan row that something still points at stays.
 */
// ponytail: reads every item and index row into memory; page through them if catalogs reach many thousands.
export async function rebuildItemsIndex(payload: Payload): Promise<{ created: number; removed: number; retitled: number }> {
  const counts = { created: 0, removed: 0, retitled: 0 }
  const rows = (await payload.find({ collection: itemsCollection.slug, pagination: false, depth: 0 })).docs as IndexRow[]
  // The unique index keeps this to one row per item.
  const rowsByItem = new Map(rows.map((row) => [`${row.itemType}:${row.itemId}`, row]))

  for (const slug of itemTypeSlugs(payload.config)) {
    const itemType = payload.collections[slug].config
    const { docs } = await payload.find({ collection: slug, pagination: false, depth: 0, select: { title: true } })
    for (const doc of docs) {
      const key = `${slug}:${doc.id}`
      const row = rowsByItem.get(key)
      rowsByItem.delete(key)
      const title = indexTitle(doc.title as string, itemType)
      if (!row) {
        await payload.create({ collection: itemsCollection.slug, data: { itemType: slug, itemId: doc.id, title } })
        counts.created++
      } else if (row.title !== title) {
        await payload.update({ collection: itemsCollection.slug, id: row.id, data: { title } })
        counts.retitled++
      }
    }
  }

  for (const row of rowsByItem.values()) {
    const uses = itemReferences(payload.config)
    const referenced = (await Promise.all(uses.map((use) => countReferences(payload, use, row.id)))).some(Boolean)
    if (referenced) {
      payload.logger.warn(
        `The items index row for ${row.itemType} ${row.itemId} has no item, but other records point at it. Delete or move them, then rebuild the index.`,
      )
      continue
    }
    await payload.delete({ collection: itemsCollection.slug, id: row.id })
    counts.removed++
  }
  return counts
}
