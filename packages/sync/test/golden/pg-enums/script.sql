-- Querybara structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 4

-- New enum labels must be committed before they can be used, so they are added first.

-- Alter type public.priority
--   non-transactional: Runs before the transaction: PostgreSQL cannot use a new enum label in the transaction that adds it
ALTER TYPE "public"."priority" ADD VALUE IF NOT EXISTS 'medium' AFTER 'low';

-- Alter type public.ticket_state
--   non-transactional: Runs before the transaction: PostgreSQL cannot use a new enum label in the transaction that adds it
ALTER TYPE "public"."ticket_state" ADD VALUE IF NOT EXISTS 'new' BEFORE 'open';
ALTER TYPE "public"."ticket_state" ADD VALUE IF NOT EXISTS 'waiting' AFTER 'open';
ALTER TYPE "public"."ticket_state" ADD VALUE IF NOT EXISTS 'archived' AFTER 'closed';

BEGIN;

-- Alter column public.tickets.state
ALTER TABLE "public"."tickets" ALTER COLUMN "state" SET DEFAULT 'new'::public.ticket_state;

-- Alter column public.tickets.prio
ALTER TABLE "public"."tickets" ALTER COLUMN "prio" SET DEFAULT 'medium'::public.priority;

COMMIT;
