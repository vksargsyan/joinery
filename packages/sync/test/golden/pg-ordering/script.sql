-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 6

BEGIN;

-- Create routine public.next_code()
CREATE OR REPLACE FUNCTION public.next_code()
 RETURNS text
 LANGUAGE sql
AS $function$ select 'C' || floor(random() * 1000)::text $function$;

-- Create table public.tickets
CREATE TABLE "public"."tickets" (
  "id" integer NOT NULL,
  "code" text DEFAULT public.next_code() NOT NULL,
  "base_id" integer,
  CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- Create foreign key public.tickets.tickets_base_id_fkey
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE "public"."tickets" ADD CONSTRAINT "tickets_base_id_fkey" FOREIGN KEY ("base_id") REFERENCES "public"."base" ("id");

-- Create routine public.open_tickets()
CREATE OR REPLACE FUNCTION public.open_tickets()
 RETURNS SETOF public.tickets
 LANGUAGE sql
 STABLE
AS $function$ select * from tickets $function$;

-- Create view public.ticket_codes
CREATE VIEW "public"."ticket_codes" AS
SELECT code
   FROM public.open_tickets() t(id, code, base_id);

-- Create view public.ticket_codes2
CREATE VIEW "public"."ticket_codes2" AS
SELECT code
   FROM public.ticket_codes;

COMMIT;
