-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 2 (1 destructive)
-- Warning: PostgreSQL names are case-sensitive, so "ignore name case" does not apply: names that differ only in case are compared as different

BEGIN;

-- Drop table public.users [destructive, not selected by default]
--   data-loss: Drops table public.users and all of its rows
DROP TABLE "public"."users";

-- Create table public.Users
CREATE TABLE "public"."Users" (
  "id" integer NOT NULL,
  "Name" text,
  CONSTRAINT "Users_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Users_Name_idx" ON public."Users" USING btree ("Name");

COMMIT;
