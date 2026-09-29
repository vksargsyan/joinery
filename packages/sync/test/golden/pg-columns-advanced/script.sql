-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 9 (1 destructive)

BEGIN;

-- Alter column public.items.id
ALTER TABLE "public"."items" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (START WITH 5 INCREMENT BY 2);

-- Alter column public.items.code
ALTER TABLE "public"."items" ALTER COLUMN "code" TYPE text COLLATE "default";

-- Alter column public.items.qty
ALTER TABLE "public"."items" ALTER COLUMN "qty" DROP DEFAULT;

-- Alter column public.items.price
--   may-fail: SET NOT NULL fails if the column holds NULLs
ALTER TABLE "public"."items" ALTER COLUMN "price" SET NOT NULL;
ALTER TABLE "public"."items" ALTER COLUMN "price" SET DEFAULT 0;

-- Alter column public.items.total [destructive, not selected by default]
--   info: The column is dropped and re-added; indexes, keys and checks on it are re-created after it
--   data-loss: Stored values are replaced by the generation expression
ALTER TABLE "public"."items" DROP COLUMN "total";
ALTER TABLE "public"."items" ADD COLUMN "total" numeric GENERATED ALWAYS AS (price * (2)::numeric) STORED;

-- Alter column public.items.tag
ALTER TABLE "public"."items" ALTER COLUMN "tag" TYPE text COLLATE "C";
COMMENT ON COLUMN "public"."items"."tag" IS NULL;

-- Alter column public.items.gen_old
ALTER TABLE "public"."items" ALTER COLUMN "gen_old" DROP EXPRESSION;

-- Alter column public.items.seq_id
ALTER TABLE "public"."items" ALTER COLUMN "seq_id" SET GENERATED ALWAYS;

-- Alter table public.items
ALTER TABLE "public"."items" SET (autovacuum_enabled=false, fillfactor=70);
COMMENT ON TABLE "public"."items" IS NULL;

COMMIT;
