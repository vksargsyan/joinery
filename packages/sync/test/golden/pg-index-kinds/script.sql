-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 8

BEGIN;

-- Alter index public.t.t_a_pattern
DROP INDEX "public"."t_a_pattern";

-- Alter index public.t.t_ab_uq
DROP INDEX "public"."t_ab_uq";

-- Alter index public.t.t_c
DROP INDEX "public"."t_c";

-- Alter index public.t.t_j_gin
DROP INDEX "public"."t_j_gin";

-- Alter index public.t.t_lower
DROP INDEX "public"."t_lower";

-- Create unique public.t.t_b_uq
ALTER TABLE "public"."t" ADD CONSTRAINT "t_b_uq" UNIQUE ("b");

-- Alter index public.t.t_a_pattern (continued)
CREATE INDEX t_a_pattern ON public.t USING btree (a text_pattern_ops);

-- Alter index public.t.t_ab_uq (continued)
CREATE UNIQUE INDEX t_ab_uq ON public.t USING btree (a, b) WHERE (b > 0);

-- Alter index public.t.t_c (continued)
CREATE INDEX t_c ON public.t USING btree (c);

-- Alter index public.t.t_j_gin (continued)
CREATE INDEX t_j_gin ON public.t USING gin (j jsonb_path_ops);

-- Alter index public.t.t_lower (continued)
CREATE INDEX t_lower ON public.t USING btree (lower(a) COLLATE "C" DESC) INCLUDE (b) WHERE ((b IS NOT NULL) AND (a <> ''::text));

-- Create index public.t.t_hash
CREATE INDEX t_hash ON public.t USING hash (b);

-- Create index public.t.t_ts_gist
CREATE INDEX t_ts_gist ON public.t USING gist (ts);

COMMIT;
