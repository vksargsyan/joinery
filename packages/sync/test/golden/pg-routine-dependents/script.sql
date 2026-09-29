-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 8

BEGIN;

-- Alter view public.tv
-- Rebuilt because public.score(integer) is re-created
DROP VIEW "public"."tv";

-- Alter column public.codes.code
-- Rebuilt because public.next_code() is re-created
ALTER TABLE "public"."codes" ALTER COLUMN "code" DROP DEFAULT;

-- Alter check public.t.t_v_check
-- Rebuilt because public.score(integer) is re-created
ALTER TABLE "public"."t" DROP CONSTRAINT "t_v_check";

-- Alter index public.t.t_score
-- Rebuilt because public.score(integer) is re-created
DROP INDEX "public"."t_score";

-- Alter routine public.next_code()
--   info: The signature or result type changed: the routine is dropped and re-created
DROP FUNCTION "public"."next_code"();

-- Alter routine public.score(integer)
--   info: The signature or result type changed: the routine is dropped and re-created
DROP FUNCTION "public"."score"(integer);

-- Alter routine public.next_code() (continued)
CREATE OR REPLACE FUNCTION public.next_code()
 RETURNS bigint
 LANGUAGE sql
AS $function$ select 42::bigint $function$;

-- Alter column public.codes.code (continued)
ALTER TABLE "public"."codes" ALTER COLUMN "code" SET DEFAULT public.next_code();

-- Alter routine public.score(integer) (continued)
CREATE OR REPLACE FUNCTION public.score(x integer)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
AS $function$ select x::bigint * 2 $function$;

-- Alter check public.t.t_v_check (continued)
ALTER TABLE "public"."t" ADD CONSTRAINT "t_v_check" CHECK ((public.score(v) >= 0));

-- Alter index public.t.t_score (continued)
CREATE INDEX t_score ON public.t USING btree (public.score(v));

-- Alter view public.tv (continued)
CREATE VIEW "public"."tv" AS
SELECT id,
    public.score(v) AS s
   FROM public.t;

-- Alter routine public.tag(text)
--   info: Indexes t_tag keep entries computed by the old code; REINDEX them if its results change
CREATE OR REPLACE FUNCTION public.tag(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select upper(t) $function$;

-- Alter routine public.trg()
CREATE OR REPLACE FUNCTION public.trg()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin return new; end $function$;

COMMIT;
