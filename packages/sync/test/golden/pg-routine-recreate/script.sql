-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 2

BEGIN;

-- Alter view public.t_fmt
-- Rebuilt because public.fmt(integer) is re-created
DROP VIEW "public"."t_fmt";

-- Alter routine public.fmt(integer)
--   info: The signature or result type changed: the routine is dropped and re-created
DROP FUNCTION "public"."fmt"(integer);
CREATE OR REPLACE FUNCTION public.fmt(x integer)
 RETURNS character varying
 LANGUAGE sql
AS $function$ select x::text $function$;

-- Alter view public.t_fmt (continued)
CREATE VIEW "public"."t_fmt" AS
SELECT id,
    public.fmt(id) AS f
   FROM public.t;

COMMIT;
