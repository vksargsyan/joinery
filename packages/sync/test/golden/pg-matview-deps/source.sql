create table m (id int primary key, amount bigint, label varchar(50));
create materialized view mv as select label, sum(amount) as total from m group by label;
create unique index mv_label on mv (label);
create view on_mv as select label from mv where total > 0;
