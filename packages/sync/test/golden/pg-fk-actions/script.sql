-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 3

BEGIN;

-- Alter foreign key public.ch.ch_c
ALTER TABLE "public"."ch" DROP CONSTRAINT "ch_c";

-- Alter foreign key public.ch.ch_p
ALTER TABLE "public"."ch" DROP CONSTRAINT "ch_p";

-- Alter foreign key public.ch.ch_self
ALTER TABLE "public"."ch" DROP CONSTRAINT "ch_self";

-- Alter foreign key public.ch.ch_c (continued)
ALTER TABLE "public"."ch" ADD CONSTRAINT "ch_c" FOREIGN KEY ("pc") REFERENCES "public"."p" ("c") ON DELETE RESTRICT;

-- Alter foreign key public.ch.ch_p (continued)
ALTER TABLE "public"."ch" ADD CONSTRAINT "ch_p" FOREIGN KEY ("pa", "pb") REFERENCES "public"."p" ("a", "b") MATCH FULL ON UPDATE CASCADE ON DELETE SET DEFAULT DEFERRABLE INITIALLY DEFERRED;

-- Alter foreign key public.ch.ch_self (continued)
ALTER TABLE "public"."ch" ADD CONSTRAINT "ch_self" FOREIGN KEY ("self") REFERENCES "public"."ch" ("id") ON DELETE CASCADE DEFERRABLE;

COMMIT;
