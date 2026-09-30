create type mood as enum ('sad', 'ok', 'happy');
create domain pos_int as integer check (value > 0);
create domain email as text check (value like '%@%');
create domain code as varchar(10);
create type pair as (a int, b varchar(10));
create type triple as (x int, y int, w text);
create table people (id int primary key, m mood default 'ok', n pos_int, e email, c code, p pair, t triple[], moods mood[]);
create view people_codes as select id, c from people;
insert into people (id, n, e, c, p, t) values (1, 5, 'a@b', 'abc', row(1, 'x'), array[row(1, 2, 'w')::triple]);
