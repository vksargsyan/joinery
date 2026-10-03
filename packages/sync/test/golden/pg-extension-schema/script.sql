-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 5 (1 destructive)

BEGIN;

-- Create schema ext
CREATE SCHEMA "ext";

-- Create extension citext
CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "ext" VERSION '1.6';

-- Create extension pg_trgm
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public" VERSION '1.6';

-- Alter column public.t.email [destructive, not selected by default]
--   data-loss: changing text to ext.citext can lose data or fail on existing values
ALTER TABLE "public"."t" ALTER COLUMN "email" TYPE ext.citext USING "email"::ext.citext;

-- Create index public.t.t_name_trgm
CREATE INDEX t_name_trgm ON public.t USING gin (name public.gin_trgm_ops);

COMMIT;
