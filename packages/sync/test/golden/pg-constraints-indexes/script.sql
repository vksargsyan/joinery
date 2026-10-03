-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 8

BEGIN;

-- Alter index public.docs.docs_lang
DROP INDEX "public"."docs_lang";

-- Drop index public.docs.docs_old
DROP INDEX "public"."docs_old";

-- Drop index public.docs.docs_title_idx
DROP INDEX "public"."docs_title_idx";

-- Rename check public.docs.docs_score_check
ALTER TABLE "public"."docs" RENAME CONSTRAINT "docs_score_chk" TO "docs_score_check";

-- Alter index public.docs.docs_lang (continued)
CREATE INDEX docs_lang ON public.docs USING btree (lang, score DESC NULLS LAST) INCLUDE (title) WHERE (lang <> 'xx'::text);
COMMENT ON INDEX "public"."docs_lang" IS 'language lookups';

-- Create index public.docs.docs_body_hash
CREATE UNIQUE INDEX docs_body_hash ON public.docs USING btree (md5(body));

-- Create index public.docs.docs_score_brin
CREATE INDEX docs_score_brin ON public.docs USING brin (score);

-- Create index public.docs.docs_title_lower_idx
CREATE INDEX docs_title_lower_idx ON public.docs USING btree (lower(title));

-- Create check public.docs.docs_title_len
--   may-fail: Adding the check fails if existing rows violate it
ALTER TABLE "public"."docs" ADD CONSTRAINT "docs_title_len" CHECK ((length(title) < 200));

COMMIT;
