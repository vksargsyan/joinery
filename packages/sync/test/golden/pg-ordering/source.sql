create table base (id int primary key);
create function next_code() returns text language sql as $$ select 'C' || floor(random() * 1000)::text $$;
create table tickets (id int primary key, code text not null default next_code(), base_id int references base(id));
create function open_tickets() returns setof tickets language sql stable as $$ select * from tickets $$;
create view ticket_codes as select t.code from open_tickets() t;
create view ticket_codes2 as select code from ticket_codes;
