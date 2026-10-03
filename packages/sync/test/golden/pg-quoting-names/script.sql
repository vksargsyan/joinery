-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 11

BEGIN;

-- Alter schema MySchema
COMMENT ON SCHEMA "MySchema" IS 'schema ''c''';

-- Create type MySchema.Status
CREATE TYPE "MySchema"."Status" AS ENUM ('Open', 'Closed''s', 'ÄÖÜ');

-- Alter column MySchema.Order.Select
COMMENT ON COLUMN "MySchema"."Order"."Select" IS 'col';

-- Create column MySchema.Order.From
ALTER TABLE "MySchema"."Order" ADD COLUMN "From" "MySchema"."Status" DEFAULT 'Open'::"MySchema"."Status";

-- Create column MySchema.Order.with space
ALTER TABLE "MySchema"."Order" ADD COLUMN "with space" text;

-- Create column MySchema.Order.ünï
ALTER TABLE "MySchema"."Order" ADD COLUMN "ünï" text DEFAULT 'ç''a'::text;

-- Create index MySchema.Order.idx Select
CREATE INDEX "idx Select" ON "MySchema"."Order" USING btree ("From", "with space");

-- Create check MySchema.Order.Order_with space_check
--   may-fail: Adding the check fails if existing rows violate it
ALTER TABLE "MySchema"."Order" ADD CONSTRAINT "Order_with space_check" CHECK (("with space" <> 'a"b'::text));

-- Alter table MySchema.Order
COMMENT ON TABLE "MySchema"."Order" IS 'multi
line ''comment'' 😀';

-- Create view MySchema.V
CREATE VIEW "MySchema"."V" AS
SELECT "Select" AS "S",
    "ünï"
   FROM "MySchema"."Order"
  WHERE ("From" = 'Closed''s'::"MySchema"."Status");

-- Create routine MySchema.Fn(integer)
CREATE OR REPLACE FUNCTION "MySchema"."Fn"("X" integer)
 RETURNS integer
 LANGUAGE sql
AS $function$ select "X" * 2 $function$;

COMMIT;
