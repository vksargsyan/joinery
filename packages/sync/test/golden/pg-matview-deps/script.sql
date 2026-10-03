-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 4

BEGIN;

-- Alter view public.on_mv
DROP VIEW "public"."on_mv";

-- Alter materialized view public.mv
-- Rebuilt because public.m.amount changes type
DROP MATERIALIZED VIEW "public"."mv";

-- Alter column public.m.amount
ALTER TABLE "public"."m" ALTER COLUMN "amount" TYPE bigint;

-- Alter column public.m.label
ALTER TABLE "public"."m" ALTER COLUMN "label" TYPE character varying(50);

-- Alter materialized view public.mv (continued)
CREATE MATERIALIZED VIEW "public"."mv" AS
SELECT label,
    sum(amount) AS total
   FROM public.m
  GROUP BY label
WITH DATA;
CREATE UNIQUE INDEX mv_label ON public.mv USING btree (label);

-- Alter view public.on_mv (continued)
CREATE VIEW "public"."on_mv" AS
SELECT label
   FROM public.mv
  WHERE (total > (0)::numeric);

COMMIT;
