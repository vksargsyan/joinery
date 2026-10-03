-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 3

BEGIN;

-- Alter column public.calc.s
--   info: The column is dropped and re-added; indexes, keys and checks on it are re-created after it
ALTER TABLE "public"."calc" DROP COLUMN "s";
ALTER TABLE "public"."calc" ADD COLUMN "s" integer GENERATED ALWAYS AS (a * b) STORED;

-- Create column public.notes.body
ALTER TABLE "public"."notes" ADD COLUMN "body" text DEFAULT ''::text NOT NULL;

-- Alter index public.calc.calc_s_idx
-- Re-created because public.calc.s is re-added
CREATE INDEX calc_s_idx ON public.calc USING btree (s);

COMMIT;
