import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { join } from 'node:path'
import { buildConfig, type CollectionConfig, type SanitizedConfig } from 'payload'
import sharp from 'sharp'
import { Media } from './collections/Media'
import { Tags } from './collections/Tags'
import { Users } from './collections/Users'
import { coreItemFields, setYearRangeFromYear } from './coreFields'
import { loadInstall, type Catalog } from './install'
import { applyDeleteRules, findItemReferences, findNestedItemReference, itemsCollection, removeIndexRow, syncIndexRow } from './items'
import { StartError, type ItemTypeDefinition, type WonderRoomPlugin } from './plugin'

export type EngineOptions = {
  catalog: Catalog
  configDir: string
  dataDir: string
  databaseUrl: string
  secret: string
  /** Where Payload looks for the admin import map. */
  importMapBaseDir?: string
  /** Where Payload writes the generated types. */
  typesOutputFile?: string
}

function buildItemTypeCollection(plugin: WonderRoomPlugin, itemType: ItemTypeDefinition): CollectionConfig {
  const coreNames = new Set(coreItemFields.map((field) => ('name' in field ? field.name : '')))
  for (const field of itemType.fields) {
    if ('name' in field && coreNames.has(field.name)) {
      throw new StartError(
        `${plugin.name} adds a field named "${field.name}", which the engine already defines. Rename the field in the plugin.`,
      )
    }
  }
  return {
    slug: itemType.slug,
    labels: itemType.labels,
    admin: { useAsTitle: 'title' },
    hooks: {
      beforeValidate: [setYearRangeFromYear],
      afterChange: [syncIndexRow],
      beforeDelete: [applyDeleteRules],
      afterDelete: [removeIndexRow],
    },
    fields: [...coreItemFields, ...itemType.fields],
  }
}

/** Delete rules see top-level references only, so a nested one stops the start. */
function rejectNestedItemReferences(plugin: WonderRoomPlugin): void {
  const collections = [
    ...(plugin.itemType ? [{ slug: plugin.itemType.slug, fields: plugin.itemType.fields }] : []),
    ...(plugin.collections ?? []),
  ]
  for (const collection of collections) {
    const nested = findNestedItemReference(collection.fields)
    if (!nested) continue
    throw new StartError(
      `${plugin.name} puts the item reference "${nested.field}" inside ${[collection.slug, ...nested.path].join('.')}. Item references must be top-level fields in this version. Move the field to the top level.`,
    )
  }
}

export async function buildEngineConfig(options: EngineOptions): Promise<SanitizedConfig> {
  const install = loadInstall(options.configDir, options.catalog)
  install.plugins.forEach(rejectNestedItemReferences)
  const itemTypes = install.plugins.flatMap((plugin) =>
    plugin.itemType ? [buildItemTypeCollection(plugin, plugin.itemType)] : [],
  )
  const addOns = install.plugins.flatMap((plugin) => plugin.collections ?? [])

  const config = await buildConfig({
    admin: {
      user: Users.slug,
      ...(options.importMapBaseDir && { importMap: { baseDir: options.importMapBaseDir } }),
    },
    // Item types come first: the rich-text link picker defaults to the first collections.
    collections: [
      ...itemTypes,
      Users,
      { ...Media, upload: { staticDir: join(options.dataDir, 'media') } },
      Tags,
      itemsCollection,
      ...addOns,
    ],
    editor: lexicalEditor(),
    secret: options.secret,
    ...(options.typesOutputFile && { typescript: { outputFile: options.typesOutputFile } }),
    db: postgresAdapter({
      pool: { connectionString: options.databaseUrl },
      migrationDir: join(options.dataDir, 'migrations'),
      push: false,
    }),
    sharp,
    custom: {
      wonderroom: {
        itemTypes: itemTypes.map((collection) => collection.slug),
        confirm: install.confirm,
      },
    },
  })
  // Found after sanitizing, so fields inside rows and collapsibles count as top level.
  config.custom.wonderroom.itemReferences = findItemReferences(config.collections)
  return config
}

export function itemTypeSlugs(config: SanitizedConfig): string[] {
  return config.custom.wonderroom.itemTypes
}
