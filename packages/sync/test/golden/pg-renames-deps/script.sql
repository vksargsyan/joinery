-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 7

BEGIN;

-- Rename table app.customers
ALTER TABLE "app"."clients" RENAME TO "customers";

-- Rename column app.customers.full_name
ALTER TABLE "app"."customers" RENAME COLUMN "name" TO "full_name";

-- Rename primary key app.customers.customers_pkey
ALTER TABLE "app"."customers" RENAME CONSTRAINT "clients_pkey" TO "customers_pkey";

-- Rename unique app.customers.customers_email_uq
ALTER TABLE "app"."customers" RENAME CONSTRAINT "clients_email_uq" TO "customers_email_uq";

-- Rename index app.customers.customers_name_idx
ALTER INDEX "app"."clients_name_idx" RENAME TO "customers_name_idx";

-- Alter view app.names
CREATE OR REPLACE VIEW "app"."names" AS
SELECT id,
    full_name
   FROM app.customers;

-- Alter routine app.cust_count()
CREATE OR REPLACE FUNCTION app.cust_count()
 RETURNS bigint
 LANGUAGE sql
AS $function$ select count(*) from app.customers $function$;

COMMIT;
