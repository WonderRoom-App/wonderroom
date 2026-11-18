import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "coins" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"year_from" numeric,
  	"manufacturer_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "featured_rels" ADD COLUMN "coins_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "coins_id" integer;
  ALTER TABLE "coins" ADD CONSTRAINT "coins_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "coins_manufacturer_idx" ON "coins" USING btree ("manufacturer_id");
  CREATE INDEX "coins_updated_at_idx" ON "coins" USING btree ("updated_at");
  CREATE INDEX "coins_created_at_idx" ON "coins" USING btree ("created_at");
  ALTER TABLE "featured_rels" ADD CONSTRAINT "featured_rels_coins_fk" FOREIGN KEY ("coins_id") REFERENCES "public"."coins"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_coins_fk" FOREIGN KEY ("coins_id") REFERENCES "public"."coins"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "featured_rels_coins_id_idx" ON "featured_rels" USING btree ("coins_id");
  CREATE INDEX "payload_locked_documents_rels_coins_id_idx" ON "payload_locked_documents_rels" USING btree ("coins_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "coins" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "coins" CASCADE;
  ALTER TABLE "featured_rels" DROP CONSTRAINT "featured_rels_coins_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_coins_fk";
  
  DROP INDEX "featured_rels_coins_id_idx";
  DROP INDEX "payload_locked_documents_rels_coins_id_idx";
  ALTER TABLE "featured_rels" DROP COLUMN "coins_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "coins_id";`)
}
