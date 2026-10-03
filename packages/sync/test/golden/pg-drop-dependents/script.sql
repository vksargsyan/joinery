-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 11 (10 destructive)

BEGIN;

-- Alter view public.av
DROP VIEW "public"."av";

-- Drop view public.av2 [destructive, not selected by default]
--   data-loss: Drops view public.av2
DROP VIEW "public"."av2";

-- Drop view public.bv [destructive, not selected by default]
--   data-loss: Drops view public.bv
DROP VIEW "public"."bv";

-- Drop table public.b [destructive, not selected by default]
--   data-loss: Drops table public.b and all of its rows
DROP TABLE "public"."b";

-- Drop column public.a.gone [destructive, not selected by default]
--   data-loss: Drops column public.a.gone and its data
ALTER TABLE "public"."a" DROP COLUMN "gone";

-- Drop column public.a.gone2 [destructive, not selected by default]
--   data-loss: Drops column public.a.gone2 and its data
ALTER TABLE "public"."a" DROP COLUMN "gone2";

-- Drop column public.c.n [destructive, not selected by default]
--   data-loss: Drops column public.c.n and its data
ALTER TABLE "public"."c" DROP COLUMN "n";

-- Drop sequence public.b_seq [destructive, not selected by default]
--   data-loss: Drops sequence public.b_seq and its current value
DROP SEQUENCE IF EXISTS "public"."b_seq";

-- Drop routine public.uses_d() [destructive, not selected by default]
--   data-loss: Drops function public.uses_d() and its code
DROP FUNCTION "public"."uses_d"();

-- Drop table public.d [destructive, not selected by default]
--   data-loss: Drops table public.d and all of its rows
DROP TABLE "public"."d";

-- Drop type public.old_enum [destructive, not selected by default]
--   data-loss: Drops type public.old_enum
DROP TYPE "public"."old_enum";

-- Alter view public.av (continued)
CREATE VIEW "public"."av" AS
SELECT id,
    keep
   FROM public.a;

COMMIT;
