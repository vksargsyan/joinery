-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 4

BEGIN;

-- Alter column Sales Dept.Order "Lines".qty;drop
ALTER TABLE "Sales Dept"."Order ""Lines""" ALTER COLUMN "qty;drop" TYPE bigint;
COMMENT ON COLUMN "Sales Dept"."Order ""Lines"""."qty;drop" IS 'semi; colon''s';

-- Create column Sales Dept.Order "Lines".Note'); DROP TABLE x; --
ALTER TABLE "Sales Dept"."Order ""Lines""" ADD COLUMN "Note'); DROP TABLE x; --" text DEFAULT 'it''s'::text;

-- Create index Sales Dept.Order "Lines".Idx "q"
CREATE INDEX "Idx ""q""" ON "Sales Dept"."Order ""Lines""" USING btree ("qty;drop");

-- Create view Sales Dept.V "1"
CREATE VIEW "Sales Dept"."V ""1""" AS
SELECT "Id",
    "qty;drop"
   FROM "Sales Dept"."Order ""Lines""";

COMMIT;
