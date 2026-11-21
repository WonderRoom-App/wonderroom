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
        `${plugin.name} adds a field named "${field.name}", which the engine already defines.`,
      )
    }
  }
  return {
    slug: itemType.slug,
    labels: itemType.labels,
    admin: { useAsTitle: 'title' },
    hooks: { beforeValidate: [setYearRangeFromYear] },
    fields: [...coreItemFields, ...itemType.fields],
  }
}

export async function buildEngineConfig(options: EngineOptions): Promise<SanitizedConfig> {
  const install = loadInstall(options.configDir, options.catalog)
  const itemTypes = install.plugins.flatMap((plugin) =>
    plugin.itemType ? [buildItemTypeCollection(plugin, plugin.itemType)] : [],
  )
  const addOns = install.plugins.flatMap((plugin) => plugin.collections ?? [])

  return buildConfig({
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
}

export function itemTypeSlugs(config: SanitizedConfig): string[] {
  return config.custom.wonderroom.itemTypes
}
