-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 4 (1 destructive)

BEGIN;

-- Alter foreign key public.shops.shops_region_code_region_zone_fkey
-- Rebuilt because the key it references on public.regions changes
ALTER TABLE "public"."shops" DROP CONSTRAINT "shops_region_code_region_zone_fkey";

-- Drop table public.kiosks [destructive, not selected by default]
--   data-loss: Drops table public.kiosks and all of its rows
DROP TABLE "public"."kiosks";

-- Alter unique public.regions.regions_code_key
ALTER TABLE "public"."regions" DROP CONSTRAINT "regions_code_key";

-- Drop unique public.regions.regions_code_only [not selected by default]
ALTER TABLE "public"."regions" DROP CONSTRAINT "regions_code_only";

-- Alter unique public.regions.regions_code_key (continued)
ALTER TABLE "public"."regions" ADD CONSTRAINT "regions_code_key" UNIQUE ("code", "zone");

-- Alter foreign key public.shops.shops_region_code_region_zone_fkey (continued)
ALTER TABLE "public"."shops" ADD CONSTRAINT "shops_region_code_region_zone_fkey" FOREIGN KEY ("region_code", "region_zone") REFERENCES "public"."regions" ("code", "zone");

COMMIT;
