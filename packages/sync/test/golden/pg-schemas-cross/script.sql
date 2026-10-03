-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 11 (2 destructive)

BEGIN;

-- Alter schema a
COMMENT ON SCHEMA "a" IS 'first';

-- Create schema b-2
CREATE SCHEMA "b-2";

-- Drop table old.x [destructive, not selected by default]
--   data-loss: Drops table old.x and all of its rows
DROP TABLE "old"."x";

-- Create type a.color
CREATE TYPE "a"."color" AS ENUM ('r', 'g');

-- Create table b-2.w
CREATE TABLE "b-2"."w" (
  "c" a.color,
  "t_id" integer
);

-- Create foreign key b-2.w.w_t_id_fkey
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE "b-2"."w" ADD CONSTRAINT "w_t_id_fkey" FOREIGN KEY ("t_id") REFERENCES "a"."t" ("id") ON DELETE SET NULL;

-- Create routine b-2.f(integer)
CREATE OR REPLACE FUNCTION "b-2".f(x integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ select x + 1 $function$;

-- Create table b-2.u
CREATE TABLE "b-2"."u" (
  "id" integer NOT NULL,
  "t_id" integer,
  "v" integer,
  CONSTRAINT "u_pkey" PRIMARY KEY ("id")
);
CREATE INDEX u_f ON "b-2".u USING btree ("b-2".f(v));

-- Create foreign key b-2.u.u_t_id_fkey
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE "b-2"."u" ADD CONSTRAINT "u_t_id_fkey" FOREIGN KEY ("t_id") REFERENCES "a"."t" ("id");

-- Create view a.v
CREATE VIEW "a"."v" AS
SELECT u.id,
    u.v
   FROM ("b-2".u
     JOIN a.t ON ((t.id = u.t_id)));

-- Drop schema old [destructive, not selected by default]
--   data-loss: Drops schema old; it must be empty once the other drops have run
DROP SCHEMA "old";

COMMIT;
