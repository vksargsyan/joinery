-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 12 (3 destructive)

BEGIN;

-- Alter view public.big_shapes
-- Rebuilt because public.shapes.qty changes type
DROP VIEW "public"."big_shapes";

-- Alter materialized view public.shape_qty
-- Rebuilt because public.shapes.qty changes type
DROP MATERIALIZED VIEW "public"."shape_qty";

-- Drop table public.shape_tags [destructive, not selected by default]
--   data-loss: Drops table public.shape_tags and all of its rows
DROP TABLE "public"."shape_tags";

-- Rename table public.new_name
ALTER TABLE "public"."old_name" RENAME TO "new_name";

-- Drop unique public.shapes.shapes_tag_key [not selected by default]
ALTER TABLE "public"."shapes" DROP CONSTRAINT "shapes_tag_key";

-- Drop index public.shapes.shapes_legacy_idx
DROP INDEX "public"."shapes_legacy_idx";

-- Drop column public.shapes.legacy [destructive, not selected by default]
--   data-loss: Drops column public.shapes.legacy and its data
ALTER TABLE "public"."shapes" DROP COLUMN "legacy";

-- Drop column public.shapes.tag [destructive, not selected by default]
--   data-loss: Drops column public.shapes.tag and its data
ALTER TABLE "public"."shapes" DROP COLUMN "tag";

-- Rename primary key public.new_name.new_name_pkey
ALTER TABLE "public"."new_name" RENAME CONSTRAINT "old_name_pkey" TO "new_name_pkey";

-- Alter type public.short_text
DROP DOMAIN "public"."short_text";
CREATE DOMAIN public.short_text AS character varying(20);

-- Alter column public.shapes.qty
ALTER TABLE "public"."shapes" ALTER COLUMN "qty" DROP DEFAULT;
ALTER TABLE "public"."shapes" ALTER COLUMN "qty" TYPE bigint;
ALTER TABLE "public"."shapes" ALTER COLUMN "qty" SET DEFAULT 0;

-- Create column public.shapes.label
ALTER TABLE "public"."shapes" ADD COLUMN "label" text DEFAULT 'none'::text NOT NULL;

-- Alter view public.big_shapes (continued)
CREATE VIEW "public"."big_shapes" AS
SELECT id
   FROM public.shapes
  WHERE (qty > 10);

-- Alter materialized view public.shape_qty (continued)
CREATE MATERIALIZED VIEW "public"."shape_qty" AS
SELECT id,
    qty
   FROM public.shapes
WITH DATA;
CREATE INDEX shape_qty_idx ON public.shape_qty USING btree (qty);

COMMIT;
