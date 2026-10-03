-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 8 (3 destructive)

BEGIN;

-- Alter partition public.l_eu [destructive, not selected by default]
--   data-loss: Recreating partition public.l_eu drops its rows
DROP TABLE "public"."l_eu";

-- Drop partition public.l_old [destructive, not selected by default]
--   data-loss: Drops partition public.l_old and its rows
DROP TABLE "public"."l_old";

-- Drop partition public.r_2023 [destructive, not selected by default]
--   data-loss: Drops partition public.r_2023 and its rows
DROP TABLE "public"."r_2023";

-- Create index public.l.l_n
CREATE INDEX l_n ON ONLY public.l USING btree (n);

-- Create partition public.l_def
CREATE TABLE "public"."l_def" PARTITION OF "public"."l" DEFAULT;

-- Alter partition public.l_eu [destructive, not selected by default] (continued)
CREATE TABLE "public"."l_eu" PARTITION OF "public"."l" FOR VALUES IN ('de', 'fr', 'it''s');

-- Create partition public.l_us
CREATE TABLE "public"."l_us" PARTITION OF "public"."l" FOR VALUES IN ('us');

-- Create partition public.r_2024
CREATE TABLE "public"."r_2024" PARTITION OF "public"."r" FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

-- Create partition public.r_min [not selected by default]
CREATE TABLE "public"."r_min" PARTITION OF "public"."r" FOR VALUES FROM (MINVALUE) TO ('2024-01-01');

COMMIT;
