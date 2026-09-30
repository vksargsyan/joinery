create table customers (
  id serial primary key,
  email varchar(320) not null,
  full_name text not null default '',
  status varchar(20) not null default 'active' check (status in ('active', 'blocked')),
  credit numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  constraint customers_email_key unique (email)
);
comment on table customers is 'People who buy things';
comment on column customers.email is 'Login e-mail';
create index customers_created_idx on customers (created_at desc);
create table orders (
  id bigint generated always as identity (start with 1000 increment by 1) primary key,
  customer_id integer not null references customers (id) on delete cascade,
  total numeric(12,2) not null check (total >= 0),
  note text,
  placed_at timestamp(3) default current_timestamp
);
create index orders_customer_idx on orders (customer_id) where total > 0;
create table order_lines (
  order_id bigint not null references orders (id) on delete cascade,
  line_no integer not null,
  sku text not null,
  qty integer not null default 1,
  primary key (order_id, line_no)
);
