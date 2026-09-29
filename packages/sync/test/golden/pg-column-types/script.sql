-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 11 (3 destructive)

BEGIN;

-- Alter view public.tv
-- Rebuilt because public.t.a changes type
DROP VIEW "public"."tv";

-- Alter index public.t.t_f [not selected by default]
DROP INDEX "public"."t_f";

-- Alter column public.child.t_a
ALTER TABLE "public"."child" ALTER COLUMN "t_a" TYPE bigint;

-- Alter column public.t.a
ALTER TABLE "public"."t" ALTER COLUMN "a" TYPE bigint;

-- Alter column public.t.b
ALTER TABLE "public"."t" ALTER COLUMN "b" TYPE text;

-- Alter column public.t.c [destructive, not selected by default]
--   data-loss: character varying(20) is shorter than text
ALTER TABLE "public"."t" ALTER COLUMN "c" TYPE character varying(20) USING "c"::character varying(20);

-- Alter column public.t.d
ALTER TABLE "public"."t" ALTER COLUMN "d" TYPE numeric(12,4);

-- Alter column public.t.e
--   may-fail: converting between timestamp without time zone and timestamp with time zone reinterprets values in the session time zone
ALTER TABLE "public"."t" ALTER COLUMN "e" TYPE timestamp with time zone USING "e"::timestamp with time zone;

-- Alter column public.t.f [destructive, not selected by default]
--   data-loss: changing text to integer can lose data or fail on existing values
ALTER TABLE "public"."t" ALTER COLUMN "f" TYPE integer USING "f"::integer;

-- Alter column public.t.g
ALTER TABLE "public"."t" ALTER COLUMN "g" TYPE text COLLATE "C";

-- Alter column public.t.h [destructive, not selected by default]
--   data-loss: changing text to text[] can lose data or fail on existing values
ALTER TABLE "public"."t" ALTER COLUMN "h" TYPE text[] USING "h"::text[];

-- Alter index public.t.t_f [not selected by default] (continued)
CREATE INDEX t_f ON public.t USING btree (f) WHERE (f > 0);

-- Alter view public.tv (continued)
CREATE VIEW "public"."tv" AS
SELECT id,
    a,
    b
   FROM public.t;

COMMIT;
