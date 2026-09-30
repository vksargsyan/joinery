-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 11 (1 destructive)

-- New enum labels must be committed before they can be used, so they are added first.

-- Alter type public.mood
--   non-transactional: Runs before the transaction: PostgreSQL cannot use a new enum label in the transaction that adds it
ALTER TYPE "public"."mood" ADD VALUE IF NOT EXISTS 'meh' AFTER 'ok';
ALTER TYPE "public"."mood" ADD VALUE IF NOT EXISTS 'it''s' AFTER 'happy';

BEGIN;

-- Alter view public.people_codes
-- Rebuilt because type public.code is recreated
DROP VIEW "public"."people_codes";

-- Create type public.float_range
CREATE TYPE "public"."float_range" AS RANGE (SUBTYPE = double precision, SUBTYPE_DIFF = float8mi);

-- Alter type public.pos_int
--   may-fail: SET NOT NULL fails if a column holds NULLs
--   may-fail: Adding the check fails if existing values violate it
ALTER DOMAIN "public"."pos_int" SET DEFAULT 1;
ALTER DOMAIN "public"."pos_int" SET NOT NULL;
ALTER DOMAIN "public"."pos_int" ADD CONSTRAINT "pos_int_small" CHECK ((VALUE < 1000));

-- Alter type public.triple [destructive, not selected by default]
--   data-loss: Values of 'w' are lost from every column of the type
ALTER TYPE "public"."triple" DROP ATTRIBUTE "w", ADD ATTRIBUTE "z" numeric(5,2);

-- Alter type public.code
--   info: The domain is recreated and its columns converted through text; functions using it must be recreated too
--   may-fail: The conversion fails on values the new definition rejects
ALTER DOMAIN "public"."code" RENAME TO "code__joinery_old";
CREATE DOMAIN "public"."code" AS character varying(20);
ALTER TABLE "public"."people" ALTER COLUMN "c" TYPE public.code USING "c"::text::public.code;
DROP DOMAIN "public"."code__joinery_old";

-- Alter type public.email
--   info: The domain is recreated and its columns converted through text; functions using it must be recreated too
--   may-fail: The conversion fails on values the new definition rejects
ALTER DOMAIN "public"."email" RENAME TO "email__joinery_old";
CREATE DOMAIN "public"."email" AS text COLLATE "C" CONSTRAINT "email_check" CHECK ((VALUE ~~ '%@%'::text));
ALTER TABLE "public"."people" ALTER COLUMN "e" TYPE public.email USING "e"::text::public.email;
DROP DOMAIN "public"."email__joinery_old";

-- Alter type public.pair
--   info: The type is recreated and its columns converted through text; functions using it must be recreated too
--   may-fail: The conversion fails on values the new definition rejects
ALTER TYPE "public"."pair" RENAME TO "pair__joinery_old";
CREATE TYPE "public"."pair" AS ("a" integer, "b" text);
ALTER TABLE "public"."people" ALTER COLUMN "p" TYPE public.pair USING "p"::text::public.pair;
DROP TYPE "public"."pair__joinery_old";

-- Alter column public.people.m
ALTER TABLE "public"."people" ALTER COLUMN "m" SET DEFAULT 'meh'::public.mood;

-- Alter column public.people.moods
ALTER TABLE "public"."people" ALTER COLUMN "moods" SET DEFAULT '{ok}'::public.mood[];

-- Create column public.people.r
ALTER TABLE "public"."people" ADD COLUMN "r" public.float_range;

-- Alter view public.people_codes (continued)
CREATE VIEW "public"."people_codes" AS
SELECT id,
    c
   FROM public.people;

COMMIT;
