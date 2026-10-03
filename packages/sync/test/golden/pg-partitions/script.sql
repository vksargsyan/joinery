-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 4 (1 destructive)

BEGIN;

-- Drop partition public.measurements_2023 [destructive, not selected by default]
--   data-loss: Drops partition public.measurements_2023 and its rows
DROP TABLE "public"."measurements_2023";

-- Create column public.measurements.unit
ALTER TABLE "public"."measurements" ADD COLUMN "unit" text;

-- Create table public.logs
CREATE TABLE "public"."logs" (
  "at" timestamp with time zone NOT NULL,
  "line" text
) PARTITION BY LIST (line);
CREATE TABLE "public"."logs_default" PARTITION OF "public"."logs" DEFAULT;

-- Create partition public.measurements_2025
CREATE TABLE "public"."measurements_2025" PARTITION OF "public"."measurements" FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

COMMIT;
