-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 7 (1 destructive)

BEGIN;

-- Alter trigger public.events.events_touch
DROP TRIGGER "events_touch" ON "public"."events";

-- Alter view public.labelled
DROP VIEW "public"."labelled";

-- Alter routine public.cleanup(integer)
--   info: The signature or result type changed: the routine is dropped and re-created
DROP PROCEDURE "public"."cleanup"();

-- Alter routine public.label(bigint)
--   info: The signature or result type changed: the routine is dropped and re-created
DROP FUNCTION "public"."label"(integer);

-- Drop routine public.old_helper() [destructive, not selected by default]
--   data-loss: Drops function public.old_helper() and its code
DROP FUNCTION "public"."old_helper"();

-- Alter routine public.add_tax(numeric)
CREATE OR REPLACE FUNCTION public.add_tax(amount numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$ select amount * 1.25 $function$;
COMMENT ON FUNCTION "public"."add_tax"(numeric) IS 'VAT';

-- Alter routine public.touch()
CREATE OR REPLACE FUNCTION public.touch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.touched := clock_timestamp();
  return new;
end $function$;

-- Alter routine public.cleanup(integer) (continued)
CREATE OR REPLACE PROCEDURE public.cleanup(IN days integer)
 LANGUAGE sql
AS $procedure$ delete from events where title is null and days > 0 $procedure$;

-- Alter routine public.label(bigint) (continued)
CREATE OR REPLACE FUNCTION public.label(i bigint)
 RETURNS text
 LANGUAGE sql
AS $function$ select 'n' || i $function$;

-- Alter view public.labelled (continued)
CREATE VIEW "public"."labelled" AS
SELECT id,
    public.label((id)::bigint) AS l
   FROM public.events;

-- Alter trigger public.events.events_touch (continued)
CREATE TRIGGER events_touch BEFORE INSERT OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.touch();

COMMIT;
