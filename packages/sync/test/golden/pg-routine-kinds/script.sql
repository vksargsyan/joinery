-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 12 (1 destructive)

BEGIN;

-- Drop routine util.gone(text) [destructive, not selected by default]
--   data-loss: Drops function util.gone(text) and its code
DROP FUNCTION "util"."gone"(text);

-- Alter routine util.add(integer, integer)
CREATE OR REPLACE FUNCTION util.add(a integer, b integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$ select a + b $function$;
COMMENT ON FUNCTION "util"."add"(integer, integer) IS 'ints';

-- Alter routine util.secret()
CREATE OR REPLACE FUNCTION util.secret()
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$ select 'x'::text $function$;

-- Create routine util.add(numeric, numeric)
CREATE OR REPLACE FUNCTION util.add(a numeric, b numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$ select a + b $function$;

-- Alter column public.t.id
ALTER TABLE "public"."t" ALTER COLUMN "id" SET DEFAULT util.add(1, 2);

-- Create index public.t.t_v
CREATE INDEX t_v ON public.t USING btree (util.add(v, v));

-- Create check public.t.t_v_check
--   may-fail: Adding the check fails if existing rows violate it
ALTER TABLE "public"."t" ADD CONSTRAINT "t_v_check" CHECK ((util.add(v, 1) > 0));

-- Create routine util.cnt(integer[])
CREATE OR REPLACE FUNCTION util.cnt(VARIADIC xs integer[])
 RETURNS integer
 LANGUAGE sql
AS $function$ select cardinality(xs) $function$;

-- Create routine util.noop(integer)
CREATE OR REPLACE PROCEDURE util.noop(INOUT x integer)
 LANGUAGE plpgsql
AS $procedure$ begin x := x + 1; end $procedure$;

-- Create routine util.sum_state(integer, integer)
CREATE OR REPLACE FUNCTION util.sum_state(s integer, v integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ select coalesce(s, 0) + coalesce(v, 0) $function$;

-- Create routine util.my_sum(integer)
CREATE AGGREGATE "util"."my_sum"(integer) (SFUNC = util.sum_state, STYPE = integer, INITCOND = '0');

-- Create routine util.tbl(integer)
CREATE OR REPLACE FUNCTION util.tbl(n integer DEFAULT 3, OUT i integer, OUT sq integer)
 RETURNS SETOF record
 LANGUAGE sql
 ROWS 10
AS $function$ select g, g*g from generate_series(1, n) g $function$;

COMMIT;
