-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 6

BEGIN;

-- Alter view public.rich
DROP VIEW "public"."rich";

-- Rename table public.accounts
ALTER TABLE "public"."wallets" RENAME TO "accounts";

-- Alter column public.accounts.balance_cents
ALTER TABLE "public"."accounts" RENAME COLUMN "balance" TO "balance_cents";

-- Rename primary key public.accounts.accounts_pkey
ALTER TABLE "public"."accounts" RENAME CONSTRAINT "wallets_pkey" TO "accounts_pkey";

-- Rename index public.accounts.accounts_balance
ALTER INDEX "public"."wallets_balance" RENAME TO "accounts_balance";

-- Rename check public.accounts.accounts_balance_cents_check
ALTER TABLE "public"."accounts" RENAME CONSTRAINT "wallets_balance_check" TO "accounts_balance_cents_check";

-- Alter column public.accounts.balance_cents (continued)
ALTER TABLE "public"."accounts" ALTER COLUMN "balance_cents" TYPE bigint;

-- Alter view public.rich (continued)
CREATE VIEW "public"."rich" AS
SELECT id,
    balance_cents
   FROM public.accounts
  WHERE (balance_cents > 100000);

COMMIT;
