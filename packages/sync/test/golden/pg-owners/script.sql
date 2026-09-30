-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 3

BEGIN;

-- Create sequence public.owned_seq
CREATE SEQUENCE "public"."owned_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "public"."owned_seq" OWNER TO "app_owner";

-- Alter table public.owned
ALTER TABLE "public"."owned" OWNER TO "app_owner";

-- Alter view public.owned_v
ALTER VIEW "public"."owned_v" OWNER TO "app_owner";

COMMIT;
