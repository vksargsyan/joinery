create table products (id int primary key, name text not null, price numeric(10,2), active boolean default true);
create table categories (id int primary key, title text);
create view active_products as select id, name, price from products where active and price is not null;
create view cheap as select price, id from products where price < 5;
create view category_list as select id, upper(title) as title from categories;
create materialized view price_stats as select count(*) as n, avg(price) as avg_price from products;
create index price_stats_n on price_stats (n);
comment on view active_products is 'Shown in the shop';
