-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 8 (1 destructive)

BEGIN;

-- Alter foreign key public.u.u_t_id_fkey
ALTER TABLE "public"."u" DROP CONSTRAINT "u_t_id_fkey";

-- Alter trigger public.t.t_upd
DROP TRIGGER "t_upd" ON "public"."t";

-- Drop trigger public.t.t_old [destructive, not selected by default]
--   data-loss: Drops trigger t_old and its code
DROP TRIGGER "t_old" ON "public"."t";

-- Alter foreign key public.u.u_t_id_fkey (continued)
ALTER TABLE "public"."u" ADD CONSTRAINT "u_t_id_fkey" FOREIGN KEY ("t_id") REFERENCES "public"."t" ("id") DEFERRABLE;

-- Alter routine public.trg()
CREATE OR REPLACE FUNCTION public.trg()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin new.updated := now(); return new; end $function$;

-- Create routine public.trg_stmt()
CREATE OR REPLACE FUNCTION public.trg_stmt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin return null; end $function$;

-- Create trigger public.t.t_stmt
CREATE TRIGGER t_stmt AFTER INSERT OR DELETE ON public.t FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stmt();

-- Create trigger public.t.t_trunc
CREATE TRIGGER t_trunc AFTER TRUNCATE ON public.t FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stmt();

-- Alter trigger public.t.t_upd (continued)
CREATE TRIGGER t_upd BEFORE UPDATE OF v, w ON public.t FOR EACH ROW WHEN ((old.v IS DISTINCT FROM new.v)) EXECUTE FUNCTION public.trg();

-- Create trigger public.u.u_ct
CREATE CONSTRAINT TRIGGER u_ct AFTER INSERT ON public.u DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.trg_stmt();

COMMIT;
