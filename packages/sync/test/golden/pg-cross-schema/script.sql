-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 4

BEGIN;

-- Create column core.users.team_id
ALTER TABLE "core"."users" ADD COLUMN "team_id" integer;

-- Create table report.teams
CREATE TABLE "report"."teams" (
  "id" integer NOT NULL,
  "title" text,
  CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- Create foreign key core.users.users_team_fk
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE "core"."users" ADD CONSTRAINT "users_team_fk" FOREIGN KEY ("team_id") REFERENCES "report"."teams" ("id");

-- Create view report.user_teams
CREATE VIEW "report"."user_teams" AS
SELECT u.id,
    t.title
   FROM (core.users u
     JOIN report.teams t ON ((t.id = u.team_id)));

COMMIT;
