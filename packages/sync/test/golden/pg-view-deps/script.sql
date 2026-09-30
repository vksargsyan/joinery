-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 5 (2 destructive)

BEGIN;

-- Drop view public.obsolete_view [destructive, not selected by default]
--   data-loss: Drops view public.obsolete_view
DROP VIEW "public"."obsolete_view";

-- Alter view public.rich
-- Rebuilt because public.balances is re-created
DROP VIEW "public"."rich";

-- Alter view public.balances
-- Rebuilt because public.accounts.balance changes type
DROP VIEW "public"."balances";

-- Drop column public.accounts.obsolete [destructive, not selected by default]
--   data-loss: Drops column public.accounts.obsolete and its data
ALTER TABLE "public"."accounts" DROP COLUMN "obsolete";

-- Alter column public.accounts.balance
ALTER TABLE "public"."accounts" ALTER COLUMN "balance" TYPE bigint;

-- Alter view public.balances (continued)
CREATE VIEW "public"."balances" AS
SELECT id,
    balance,
    code
   FROM public.accounts;

-- Alter view public.rich (continued)
CREATE VIEW "public"."rich" AS
SELECT id,
    balance
   FROM public.balances
  WHERE (balance > 1000);

COMMIT;
