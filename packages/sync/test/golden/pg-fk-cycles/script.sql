-- Joinery structure sync
-- Source: postgres app_dev
-- Target: postgres app_prod
-- Operations: 9 (2 destructive)

BEGIN;

-- Drop foreign key public.a_old.a_old_b_fk
-- Lets public.b_old be dropped
ALTER TABLE "public"."a_old" DROP CONSTRAINT "a_old_b_fk";

-- Drop foreign key public.b_old.b_old_a_id_fkey
-- Lets public.a_old be dropped
ALTER TABLE "public"."b_old" DROP CONSTRAINT "b_old_a_id_fkey";

-- Create table public.authors
CREATE TABLE "public"."authors" (
  "id" integer NOT NULL,
  "favourite_book" integer,
  CONSTRAINT "authors_pkey" PRIMARY KEY ("id")
);

-- Create table public.books
CREATE TABLE "public"."books" (
  "id" integer NOT NULL,
  "author_id" integer NOT NULL,
  "keep_id" integer,
  CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- Create foreign key public.authors.authors_favourite_fk
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE "public"."authors" ADD CONSTRAINT "authors_favourite_fk" FOREIGN KEY ("favourite_book") REFERENCES "public"."books" ("id") DEFERRABLE INITIALLY DEFERRED;

-- Create foreign key public.books.books_author_id_fkey
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE "public"."books" ADD CONSTRAINT "books_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."authors" ("id");

-- Create foreign key public.books.books_keep_id_fkey
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE "public"."books" ADD CONSTRAINT "books_keep_id_fkey" FOREIGN KEY ("keep_id") REFERENCES "public"."keep" ("id");

-- Drop table public.a_old [destructive, not selected by default]
--   data-loss: Drops table public.a_old and all of its rows
DROP TABLE "public"."a_old";

-- Drop table public.b_old [destructive, not selected by default]
--   data-loss: Drops table public.b_old and all of its rows
DROP TABLE "public"."b_old";

COMMIT;
