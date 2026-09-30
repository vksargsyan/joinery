create type mood as enum ('sad', 'ok', 'meh', 'happy', 'it''s');
create domain pos_int as integer default 1 not null constraint pos_int_check check (value > 0) constraint pos_int_small check (value < 1000);
create domain email as text collate "C" check (value like '%@%');
create domain code as varchar(20);
create type pair as (a int, b text);
create type triple as (x int, y int, z numeric(5,2));
create type float_range as range (subtype = float8, subtype_diff = float8mi);
create table people (id int primary key, m mood default 'meh', n pos_int, e email, c code, p pair, t triple[], r float_range, moods mood[] default '{ok}');
create view people_codes as select id, c from people;
