// Approach A: each plugin ships its own up() functions, passed to prodMigrations in order.
// Throwaway. Run: NODE_ENV=production DATABASE_URL=... npx tsx approachA.ts
import { sql } from '@payloadcms/db-postgres'
import { getPayload } from 'payload'

import { buildConfig } from './payload.config.ts'
// The engine's own init: core tables plus typewriters, makers, featured (from Task 2).
import * as engineInit from './record/task2/20261118_164300_init.ts'

// A plugin migration with table names built from the slug the owner picked.
const itemTypeCreate = (slug: string) => {
  const t = slug.replace(/-/g, '_')
  return {
    name: `item-type:${slug}:create`,
    up: async ({ db }: any) => {
      await db.execute(sql.raw(`
        CREATE TABLE "${t}" ("id" serial PRIMARY KEY NOT NULL, "title" varchar NOT NULL,
          "year_from" numeric, "manufacturer_id" integer,
          "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
          "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL);
        -- The plugin must also know about an engine table:
        ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "${t}_id" integer;`))
    },
    down: async () => {},
  }
}

const migrations = [
  { name: 'engine:init', up: engineInit.up, down: engineInit.down },
  itemTypeCreate('coins'),
]

const payload = await getPayload({
  config: buildConfig(['typewriters', 'coins', 'makers', 'featured'], migrations),
})

const ran = await payload.find({ collection: 'payload-migrations' as any, limit: 10 })
console.log('migrations recorded:', ran.docs.map((d: any) => d.name))

const coin = await payload.create({ collection: 'coins' as any, data: { title: 'Athenian owl' } })
console.log('coin created:', coin.id)
try {
  await payload.create({
    collection: 'featured' as any,
    data: { machine: { relationTo: 'coins', value: coin.id } },
  })
  console.log('featured -> coin: OK')
} catch (err) {
  console.log('featured -> coin FAILED:', String(err).slice(0, 300))
}
process.exit(0)
