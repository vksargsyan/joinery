create table events (id serial primary key, title text, touched timestamptz);
create function add_tax(amount numeric) returns numeric language sql immutable as $$ select amount * 1.25 $$;
create function touch() returns trigger language plpgsql as $$
begin
  new.touched := clock_timestamp();
  return new;
end $$;
create trigger events_touch before insert or update on events for each row execute function touch();
create function label(i bigint) returns text language sql as $$ select 'n' || i $$;
create view labelled as select id, label(id) as l from events;
create procedure cleanup(days int) language sql as $$ delete from events where title is null and days > 0 $$;
comment on function add_tax(numeric) is 'VAT';
