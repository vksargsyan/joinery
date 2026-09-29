create table m (id int primary key, amount int, label varchar(20));
create materialized view mv as select label, sum(amount) as total from m group by label;
create unique index mv_label on mv (label);
create view on_mv as select label from mv where total > 0;
