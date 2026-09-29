create table t (id int primary key, a int, b text, c numeric);
create view v1 as select id, a, b from t where a > 0;
create view v2 as select v1.id, v1.a, length(v1.b) as len from v1;
create materialized view mv as select a, count(*) as n from t group by a;
create index mv_a on mv (a);
