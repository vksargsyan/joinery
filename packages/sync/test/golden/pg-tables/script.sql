-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 21 (5 destructive)

BEGIN;

-- Alter foreign key public.orders.orders_customer_id_fkey
ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_customer_id_fkey";

-- Drop table public.audit_log [destructive, not selected by default]
--   data-loss: Drops table public.audit_log and all of its rows
DROP TABLE "public"."audit_log";

-- Drop column public.customers.legacy_code [destructive, not selected by default]
--   data-loss: Drops column public.customers.legacy_code and its data
ALTER TABLE "public"."customers" DROP COLUMN "legacy_code";

-- Alter column public.customers.email
ALTER TABLE "public"."customers" ALTER COLUMN "email" TYPE character varying(320);
COMMENT ON COLUMN "public"."customers"."email" IS 'Login e-mail';

-- Alter column public.customers.full_name
--   may-fail: SET NOT NULL fails if the column holds NULLs
ALTER TABLE "public"."customers" ALTER COLUMN "full_name" TYPE text;
ALTER TABLE "public"."customers" ALTER COLUMN "full_name" SET NOT NULL;
ALTER TABLE "public"."customers" ALTER COLUMN "full_name" SET DEFAULT ''::text;

-- Alter column public.customers.status
ALTER TABLE "public"."customers" ALTER COLUMN "status" SET DEFAULT 'active'::character varying;

-- Alter column public.customers.created_at
--   may-fail: converting between timestamp without time zone and timestamp with time zone reinterprets values in the session time zone
ALTER TABLE "public"."customers" ALTER COLUMN "created_at" DROP DEFAULT;
ALTER TABLE "public"."customers" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at"::timestamp with time zone;
ALTER TABLE "public"."customers" ALTER COLUMN "created_at" SET DEFAULT now();

-- Alter column public.orders.id
ALTER TABLE "public"."orders" ALTER COLUMN "id" SET START WITH 1000;

-- Alter column public.orders.customer_id [destructive, not selected by default]
--   data-loss: integer is narrower than bigint
ALTER TABLE "public"."orders" ALTER COLUMN "customer_id" TYPE integer USING "customer_id"::integer;

-- Alter column public.orders.total
ALTER TABLE "public"."orders" ALTER COLUMN "total" TYPE numeric(12,2);

-- Alter column public.orders.placed_at [destructive, not selected by default]
--   data-loss: timestamp(3) without time zone rounds fractional seconds of timestamp(6) without time zone
ALTER TABLE "public"."orders" ALTER COLUMN "placed_at" DROP DEFAULT;
ALTER TABLE "public"."orders" ALTER COLUMN "placed_at" TYPE timestamp(3) without time zone USING "placed_at"::timestamp(3) without time zone;
ALTER TABLE "public"."orders" ALTER COLUMN "placed_at" SET DEFAULT CURRENT_TIMESTAMP;

-- Create column public.customers.credit
ALTER TABLE "public"."customers" ADD COLUMN "credit" numeric(12,2) DEFAULT 0 NOT NULL;

-- Create column public.orders.note
ALTER TABLE "public"."orders" ADD COLUMN "note" text;

-- Create index public.customers.customers_created_idx
CREATE INDEX customers_created_idx ON public.customers USING btree (created_at DESC);

-- Create check public.customers.customers_status_check
--   may-fail: Adding the check fails if existing rows violate it
ALTER TABLE "public"."customers" ADD CONSTRAINT "customers_status_check" CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'blocked'::character varying])::text[])));

-- Create index public.orders.orders_customer_idx
CREATE INDEX orders_customer_idx ON public.orders USING btree (customer_id) WHERE (total > (0)::numeric);

-- Create check public.orders.orders_total_check
--   may-fail: Adding the check fails if existing rows violate it
ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_total_check" CHECK ((total >= (0)::numeric));

-- Alter table public.customers
COMMENT ON TABLE "public"."customers" IS 'People who buy things';

-- Create table public.order_lines
CREATE TABLE "public"."order_lines" (
  "order_id" bigint NOT NULL,
  "line_no" integer NOT NULL,
  "sku" text NOT NULL,
  "qty" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "order_lines_pkey" PRIMARY KEY ("order_id", "line_no")
);

-- Drop sequence public.audit_log_id_seq [destructive, not selected by default]
--   data-loss: Drops sequence public.audit_log_id_seq and its current value
DROP SEQUENCE IF EXISTS "public"."audit_log_id_seq";

-- Create foreign key public.order_lines.order_lines_order_id_fkey
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE "public"."order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders" ("id") ON DELETE CASCADE;

-- Alter foreign key public.orders.orders_customer_id_fkey (continued)
ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") ON DELETE CASCADE;

COMMIT;
