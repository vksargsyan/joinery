create schema util;
create function util.add(a int, b int) returns int language sql as $$ select a + b + 0 $$;
create function util.secret() returns text language sql as $$ select 'y'::text $$;
create function util.gone(x text) returns text language sql as $$ select x $$;
create table t (id int primary key, v int);
