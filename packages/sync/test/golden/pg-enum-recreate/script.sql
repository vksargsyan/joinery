-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 2 (1 destructive)

BEGIN;

-- Alter view public.reds [not selected by default]
-- Rebuilt because type public.color is recreated
DROP VIEW "public"."reds";

-- Alter type public.color [destructive, not selected by default]
--   info: The enum is recreated and its columns converted through text; functions using it must be recreated too
--   data-loss: Rows holding 'purple' make the conversion fail
ALTER TYPE "public"."color" RENAME TO "color__querybara_old";
CREATE TYPE "public"."color" AS ENUM ('blue', 'green', 'red');
ALTER TABLE "public"."paints" ALTER COLUMN "c" DROP DEFAULT;
ALTER TABLE "public"."paints" ALTER COLUMN "c" TYPE public.color USING "c"::text::public.color;
ALTER TABLE "public"."paints" ALTER COLUMN "c" SET DEFAULT 'red'::public.color;
ALTER TABLE "public"."paints" ALTER COLUMN "palette" TYPE public.color[] USING "palette"::text[]::public.color[];
DROP TYPE "public"."color__querybara_old";

-- Alter view public.reds [not selected by default] (continued)
CREATE VIEW "public"."reds" AS
SELECT id,
    c
   FROM public.paints
  WHERE (c = 'red'::public.color);

COMMIT;
