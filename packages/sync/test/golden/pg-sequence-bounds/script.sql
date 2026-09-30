-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 10 (1 destructive)

BEGIN;

-- Create sequence public.s2
CREATE SEQUENCE "public"."s2" AS bigint INCREMENT BY -1 MINVALUE -1000 MAXVALUE -1 START WITH -1 CACHE 1 NO CYCLE;

-- Alter column public.t.code
ALTER TABLE "public"."t" ALTER COLUMN "code" SET START WITH 100 SET INCREMENT BY 10;

-- Alter sequence public.s1
--   info: A current value outside the new range is moved to its nearest end
SELECT pg_catalog.setval('"public"."s1"', CASE WHEN last_value < 5 THEN 5 ELSE 1000000 END, false) FROM "public"."s1" WHERE last_value < 5 OR last_value > 1000000;
ALTER SEQUENCE "public"."s1" AS integer INCREMENT BY 5 MINVALUE 5 MAXVALUE 1000000 START WITH 10 CACHE 20 CYCLE;

-- Alter column public.t.n
ALTER TABLE "public"."t" ALTER COLUMN "n" SET DEFAULT nextval('public.s1'::regclass);

-- Alter sequence public.owned_later
ALTER SEQUENCE "public"."owned_later" OWNED BY "public"."t"."n";

-- Alter sequence public.s4
--   info: A current value outside the new range is moved to its nearest end
SELECT pg_catalog.setval('"public"."s4"', 2, false) FROM "public"."s4" WHERE last_value > 2;
ALTER SEQUENCE "public"."s4" MAXVALUE 2;

-- Alter sequence public.s5
--   info: The new range excludes every current value: the sequence restarts at START
ALTER SEQUENCE "public"."s5" MINVALUE 200 MAXVALUE 300 START WITH 250 RESTART;

-- Drop sequence public.s3 [destructive, not selected by default]
--   data-loss: Drops sequence public.s3 and its current value
DROP SEQUENCE IF EXISTS "public"."s3";

-- Alter column public.t.id
ALTER TABLE "public"."t" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "public"."t" ALTER COLUMN "id" TYPE bigint;
ALTER TABLE "public"."t" ALTER COLUMN "id" SET DEFAULT nextval('public.t_id_seq'::regclass);

-- Alter sequence public.t_id_seq
ALTER SEQUENCE "public"."t_id_seq" AS bigint MAXVALUE 9223372036854775807;

COMMIT;
