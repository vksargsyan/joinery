create table events (id serial primary key, title text, touched timestamptz);
create function add_tax(amount numeric) returns numeric language sql immutable as $$ select amount * 1.2 $$;
create function old_helper() returns int language sql as $$ select 1 $$;
create function touch() returns trigger language plpgsql as $$ begin new.touched := now(); return new; end $$;
create trigger events_touch before update on events for each row execute function touch();
create function label(i int) returns text language sql as $$ select 'n' || i $$;
create view labelled as select id, label(id) as l from events;
create procedure cleanup() language sql as $$ delete from events where title is null $$;
