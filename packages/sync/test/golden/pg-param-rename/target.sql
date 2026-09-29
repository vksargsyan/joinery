create function greet(who text) returns text language sql as $$ select 'hi ' || who $$;
create function area(w int, h int default 1) returns int language sql as $$ select w * h $$;
