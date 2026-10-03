-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 3

BEGIN;

-- Drop foreign key public.children.children_parent_id_fkey
ALTER TABLE "public"."children" DROP CONSTRAINT "children_parent_id_fkey";

-- Alter primary key public.parents.parents_pkey
ALTER TABLE "public"."parents" DROP CONSTRAINT "parents_pkey";

-- Alter column public.parents.region
--   may-fail: SET NOT NULL fails if the column holds NULLs
ALTER TABLE "public"."parents" ALTER COLUMN "region" SET NOT NULL;
ALTER TABLE "public"."parents" ALTER COLUMN "region" SET DEFAULT 'eu'::text;

-- Alter primary key public.parents.parents_pkey (continued)
ALTER TABLE "public"."parents" ADD CONSTRAINT "parents_pkey" PRIMARY KEY ("id", "region");

COMMIT;
