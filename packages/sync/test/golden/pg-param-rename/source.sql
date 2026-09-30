create function greet(person text) returns text language sql as $$ select 'hi ' || person $$;
create function area(w int, h int) returns int language sql as $$ select w * h $$;
