create schema "MySchema";
create type "MySchema"."Status" as enum ('Open', 'Closed''s', 'ÄÖÜ');
create table "MySchema"."Order" ("Select" int primary key, "From" "MySchema"."Status" default 'Open', "with space" text check ("with space" <> 'a"b'), "ünï" text default 'ç''a');
create index "idx Select" on "MySchema"."Order" ("From", "with space");
create view "MySchema"."V" as select "Select" as "S", "ünï" from "MySchema"."Order" where "From" = 'Closed''s';
comment on table "MySchema"."Order" is E'multi\nline ''comment'' 😀';
comment on column "MySchema"."Order"."Select" is 'col';
comment on schema "MySchema" is 'schema ''c''';
create function "MySchema"."Fn"("X" int) returns int language sql as $f$ select "X" * 2 $f$;
