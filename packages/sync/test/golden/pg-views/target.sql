create table products (id int primary key, name text not null, price numeric(10,2), active boolean default true);
create view active_products as select id, name from products where active;
create view cheap as select id, price from products where price < 10;
create view legacy as select id from products;
create materialized view price_stats as select count(*) as n from products;
create index price_stats_n on price_stats (n);
