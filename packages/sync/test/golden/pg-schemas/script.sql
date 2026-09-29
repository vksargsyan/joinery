-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 11 (3 destructive)

BEGIN;

-- Create schema billing
CREATE SCHEMA "billing";
COMMENT ON SCHEMA "billing" IS 'Money';

-- Create extension pgcrypto
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "public" VERSION '1.3';

-- Drop table old_stuff.junk [destructive, not selected by default]
--   data-loss: Drops table old_stuff.junk and all of its rows
DROP TABLE "old_stuff"."junk";

-- Create type public.money_pair
CREATE TYPE public.money_pair AS (amount numeric, currency character(3));

-- Create type public.positive_int
CREATE DOMAIN public.positive_int AS integer CONSTRAINT positive_int_check CHECK ((VALUE > 0));

-- Create sequence billing.invoice_no
CREATE SEQUENCE "billing"."invoice_no" AS integer INCREMENT BY 10 MINVALUE 1 MAXVALUE 2147483647 START WITH 1000 CACHE 5 NO CYCLE;

-- Create table billing.invoices
CREATE TABLE "billing"."invoices" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "no" integer DEFAULT nextval('billing.invoice_no'::regclass) NOT NULL,
  "total" numeric,
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);
ALTER SEQUENCE "billing"."invoice_no" OWNED BY "billing"."invoices"."no";

-- Create table public.wallets
CREATE TABLE "public"."wallets" (
  "id" integer NOT NULL,
  "credits" public.positive_int,
  "pair" public.money_pair,
  CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- Alter sequence public.counter
ALTER SEQUENCE "public"."counter" INCREMENT BY 5 MAXVALUE 1000000 CYCLE;

-- Drop sequence public.unused_seq [destructive, not selected by default]
--   data-loss: Drops sequence public.unused_seq and its current value
DROP SEQUENCE IF EXISTS "public"."unused_seq";

-- Drop schema old_stuff [destructive, not selected by default]
--   data-loss: Drops schema old_stuff; it must be empty once the other drops have run
DROP SCHEMA "old_stuff";

COMMIT;
