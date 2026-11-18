import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// Written by the engine from a rename a plugin declared (simulated by hand).
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "typewriters" RENAME COLUMN "ribbon_size" TO "ribbon_width";
    ALTER TABLE "office_machines" RENAME COLUMN "ribbon_size" TO "ribbon_width";`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "typewriters" RENAME COLUMN "ribbon_width" TO "ribbon_size";
    ALTER TABLE "office_machines" RENAME COLUMN "ribbon_width" TO "ribbon_size";`)
}
