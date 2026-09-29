-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 4

BEGIN;

-- Alter column public.child.parent_id
ALTER TABLE "public"."child" ALTER COLUMN "parent_id" TYPE bigint;

-- Alter column public.child.parent_code
ALTER TABLE "public"."child" ALTER COLUMN "parent_code" TYPE character varying(40);

-- Alter column public.parent.id
ALTER TABLE "public"."parent" ALTER COLUMN "id" TYPE bigint;

-- Alter column public.parent.code
ALTER TABLE "public"."parent" ALTER COLUMN "code" TYPE character varying(40);

COMMIT;
