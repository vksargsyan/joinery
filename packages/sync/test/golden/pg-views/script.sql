-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 6 (1 destructive)

BEGIN;

-- Alter view public.cheap
DROP VIEW "public"."cheap";

-- Alter materialized view public.price_stats
DROP MATERIALIZED VIEW "public"."price_stats";

-- Drop view public.legacy [destructive, not selected by default]
--   data-loss: Drops view public.legacy
DROP VIEW "public"."legacy";

-- Create table public.categories
CREATE TABLE "public"."categories" (
  "id" integer NOT NULL,
  "title" text,
  CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- Alter view public.active_products
CREATE OR REPLACE VIEW "public"."active_products" AS
SELECT id,
    name,
    price
   FROM public.products
  WHERE (active AND (price IS NOT NULL));
COMMENT ON VIEW "public"."active_products" IS 'Shown in the shop';

-- Create view public.category_list
CREATE VIEW "public"."category_list" AS
SELECT id,
    upper(title) AS title
   FROM public.categories;

-- Alter view public.cheap (continued)
CREATE VIEW "public"."cheap" AS
SELECT price,
    id
   FROM public.products
  WHERE (price < (5)::numeric);

-- Alter materialized view public.price_stats (continued)
CREATE MATERIALIZED VIEW "public"."price_stats" AS
SELECT count(*) AS n,
    avg(price) AS avg_price
   FROM public.products
WITH DATA;
CREATE INDEX price_stats_n ON public.price_stats USING btree (n);

COMMIT;
