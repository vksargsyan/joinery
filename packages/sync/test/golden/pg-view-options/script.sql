-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 8

BEGIN;

-- Alter view public.v2
DROP VIEW "public"."v2";

-- Alter view public.v1
DROP VIEW "public"."v1";

-- Drop index public.mv.mv_a
DROP INDEX "public"."mv_a";

-- Alter materialized view public.mv
COMMENT ON MATERIALIZED VIEW "public"."mv" IS 'mat';

-- Create index public.mv.mv_a
CREATE UNIQUE INDEX mv_a ON public.mv USING btree (a);

-- Create index public.mv.mv_n
CREATE INDEX mv_n ON public.mv USING btree (n DESC);

-- Create view public.nums
CREATE VIEW "public"."nums" AS
WITH RECURSIVE nums(n) AS (
         VALUES (1)
        UNION ALL
         SELECT (nums_1.n + 1)
           FROM nums nums_1
          WHERE (nums_1.n < 10)
        )
 SELECT n
   FROM nums;

-- Alter view public.v1 (continued)
CREATE VIEW "public"."v1" WITH (security_barrier=true) AS
SELECT id,
    a AS alpha,
    b
   FROM public.t
  WHERE (a > 0)
WITH CASCADED CHECK OPTION;

-- Alter view public.v2 (continued)
CREATE VIEW "public"."v2" AS
SELECT id,
    alpha,
    length(b) AS len
   FROM public.v1;

-- Create view public.v3
CREATE VIEW "public"."v3" AS
SELECT id,
    c
   FROM public.t
  ORDER BY c DESC NULLS LAST
 LIMIT 10;

COMMIT;
