create schema app;
create table app.customers (id int primary key, full_name text not null, email text, constraint customers_email_uq unique (email), constraint name_len check (length(full_name) > 1));
create index customers_name_idx on app.customers (full_name);
create table app.orders (id int primary key, customer_id int references app.customers (id), note text);
create view app.names as select id, full_name from app.customers;
create function app.cust_count() returns bigint language sql as $$ select count(*) from app.customers $$;
create sequence app.order_seq owned by app.orders.id;
