create table t (id int primary key, a bigint, b text, c varchar(20), d numeric(12,4), e timestamptz, f int, g text collate "C", h text[]);
create index t_b on t (b);
create index t_f on t (f) where f > 0;
create view tv as select id, a, b from t;
create table child (id int primary key, t_a bigint);
alter table t add constraint t_a_uq unique (a);
alter table child add constraint child_fk foreign key (t_a) references t (a);
