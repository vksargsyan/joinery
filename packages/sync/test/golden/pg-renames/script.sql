-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 6

BEGIN;

-- Alter view public.customer_names
DROP VIEW "public"."client_names";

-- Rename sequence public.customers_id_seq
ALTER SEQUENCE "public"."clients_id_seq" RENAME TO "customers_id_seq";

-- Rename table public.customers
ALTER TABLE "public"."clients" RENAME TO "customers";

-- Rename column public.customers.first_name
ALTER TABLE "public"."customers" RENAME COLUMN "fname" TO "first_name";

-- Rename primary key public.customers.customers_pkey
ALTER TABLE "public"."customers" RENAME CONSTRAINT "clients_pkey" TO "customers_pkey";

-- Rename index public.customers.customers_email_idx
ALTER INDEX "public"."clients_email_idx" RENAME TO "customers_email_idx";

-- Alter view public.customer_names (continued)
CREATE VIEW "public"."customer_names" AS
SELECT id,
    first_name,
    lname
   FROM public.customers;

COMMIT;
