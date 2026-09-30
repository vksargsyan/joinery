create schema app;
create table app.clients (id int primary key, name text not null, email text, constraint clients_email_uq unique (email), constraint name_len check (length(name) > 1));
create index clients_name_idx on app.clients (name);
create table app.orders (id int primary key, customer_id int references app.clients (id), note text);
create view app.names as select id, name as full_name from app.clients;
create function app.cust_count() returns bigint language sql as $$ select count(*) from app.clients $$;
create sequence app.order_seq owned by app.orders.id;
