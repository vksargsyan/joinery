-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 19

BEGIN;

-- Create extension pgcrypto
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "public" VERSION '1.3';

-- Alter column public.d.id
ALTER TABLE "public"."d" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- Alter column public.d.a
ALTER TABLE "public"."d" ALTER COLUMN "a" SET DEFAULT '-1'::integer;

-- Alter column public.d.b
ALTER TABLE "public"."d" ALTER COLUMN "b" SET DEFAULT 1.50;

-- Alter column public.d.c
ALTER TABLE "public"."d" ALTER COLUMN "c" SET DEFAULT 'x'::text;

-- Alter column public.d.dt
ALTER TABLE "public"."d" ALTER COLUMN "dt" SET DEFAULT CURRENT_DATE;

-- Alter column public.d.ts
ALTER TABLE "public"."d" ALTER COLUMN "ts" SET DEFAULT (now() AT TIME ZONE 'utc'::text);

-- Alter column public.d.iv
ALTER TABLE "public"."d" ALTER COLUMN "iv" SET DEFAULT '1 day'::interval;

-- Alter column public.d.j
ALTER TABLE "public"."d" ALTER COLUMN "j" SET DEFAULT '{"a": [1, 2]}'::jsonb;

-- Alter column public.d.arr
ALTER TABLE "public"."d" ALTER COLUMN "arr" SET DEFAULT '{}'::integer[];

-- Alter column public.d.arr2
ALTER TABLE "public"."d" ALTER COLUMN "arr2" SET DEFAULT ARRAY['a'::text, 'b'::text];

-- Alter column public.d.f
ALTER TABLE "public"."d" ALTER COLUMN "f" SET DEFAULT 'NaN'::double precision;

-- Alter column public.d.bits
ALTER TABLE "public"."d" ALTER COLUMN "bits" SET DEFAULT '101'::"bit";

-- Alter column public.d.bo
ALTER TABLE "public"."d" ALTER COLUMN "bo" SET DEFAULT false;

-- Alter column public.d.expr
ALTER TABLE "public"."d" ALTER COLUMN "expr" SET DEFAULT ((1 + 2) * 3);

-- Alter column public.d.money_col
ALTER TABLE "public"."d" ALTER COLUMN "money_col" SET DEFAULT 12.5;

-- Alter column public.d.ch
ALTER TABLE "public"."d" ALTER COLUMN "ch" SET DEFAULT 'ab'::bpchar;

-- Alter column public.d.vc
ALTER TABLE "public"."d" ALTER COLUMN "vc" SET DEFAULT 'x'::character varying;

-- Alter column public.d.tz
ALTER TABLE "public"."d" ALTER COLUMN "tz" SET DEFAULT '2024-01-01 00:00:00+00'::timestamp with time zone;

COMMIT;
