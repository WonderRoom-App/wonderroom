import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "office_machines" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"year_from" numeric,
  	"ribbon_size" varchar,
  	"manufacturer_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "featured_rels" ADD COLUMN "office_machines_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "office_machines_id" integer;
  ALTER TABLE "office_machines" ADD CONSTRAINT "office_machines_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "office_machines_manufacturer_idx" ON "office_machines" USING btree ("manufacturer_id");
  CREATE INDEX "office_machines_updated_at_idx" ON "office_machines" USING btree ("updated_at");
  CREATE INDEX "office_machines_created_at_idx" ON "office_machines" USING btree ("created_at");
  ALTER TABLE "featured_rels" ADD CONSTRAINT "featured_rels_office_machines_fk" FOREIGN KEY ("office_machines_id") REFERENCES "public"."office_machines"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_office_machines_fk" FOREIGN KEY ("office_machines_id") REFERENCES "public"."office_machines"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "featured_rels_office_machines_id_idx" ON "featured_rels" USING btree ("office_machines_id");
  CREATE INDEX "payload_locked_documents_rels_office_machines_id_idx" ON "payload_locked_documents_rels" USING btree ("office_machines_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "office_machines" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "office_machines" CASCADE;
  ALTER TABLE "featured_rels" DROP CONSTRAINT "featured_rels_office_machines_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_office_machines_fk";
  
  DROP INDEX "featured_rels_office_machines_id_idx";
  DROP INDEX "payload_locked_documents_rels_office_machines_id_idx";
  ALTER TABLE "featured_rels" DROP COLUMN "office_machines_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "office_machines_id";`)
}
