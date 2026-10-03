-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 2

BEGIN;

-- Alter routine public.area(integer, integer)
--   info: The signature or result type changed: the routine is dropped and re-created
DROP FUNCTION "public"."area"(integer, integer);

-- Alter routine public.greet(text)
--   info: The signature or result type changed: the routine is dropped and re-created
DROP FUNCTION "public"."greet"(text);

-- Alter routine public.area(integer, integer) (continued)
CREATE OR REPLACE FUNCTION public.area(w integer, h integer)
 RETURNS integer
 LANGUAGE sql
AS $function$ select w * h $function$;

-- Alter routine public.greet(text) (continued)
CREATE OR REPLACE FUNCTION public.greet(person text)
 RETURNS text
 LANGUAGE sql
AS $function$ select 'hi ' || person $function$;

COMMIT;
