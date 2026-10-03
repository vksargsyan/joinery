-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 1

BEGIN;

-- Create column public.notes.pinned
ALTER TABLE "public"."notes" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;

COMMIT;
