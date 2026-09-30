create table customers (
  id serial primary key,
  email varchar(255) not null,
  full_name varchar(100),
  status varchar(20) not null default 'new',
  legacy_code char(8),
  created_at timestamp not null default now(),
  constraint customers_email_key unique (email)
);
create table orders (
  id bigint generated always as identity primary key,
  customer_id bigint not null references customers (id),
  total numeric(10,2) not null,
  placed_at timestamp(6) default current_timestamp
);
create table audit_log (id serial primary key, payload text);
