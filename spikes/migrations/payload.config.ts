// Payload config built from a plugin list in WR_PLUGINS. Throwaway.
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig as payloadBuildConfig } from 'payload'

import { resolve } from './plugins.ts'

type ProdMigration = { name: string; up: (args: any) => Promise<void>; down: (args: any) => Promise<void> }

export function buildConfig(pluginList: string[], prodMigrations?: ProdMigration[]) {
  const plugins = pluginList.map(resolve)
  const loaded = new Set(plugins.map((p) => p.name))
  const itemSlugs = plugins.flatMap((p) => (p.itemTypeSlug ? [p.itemTypeSlug] : []))
  const collections = plugins.flatMap((p) => p.collections({ itemSlugs, loaded }))

  return payloadBuildConfig({
    secret: 'spike',
    collections,
    typescript: { autoGenerate: false },
    db: postgresAdapter({
      pool: { connectionString: process.env.DATABASE_URL || '' },
      migrationDir: process.env.WR_MIGRATIONS_DIR || '',
      push: process.env.WR_PUSH === '1',
      prodMigrations,
    }),
  })
}

export default buildConfig((process.env.WR_PLUGINS || '').split(',').filter(Boolean))
