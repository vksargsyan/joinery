create table t (id int primary key, a int, b varchar(10), c text, d numeric(10,2), e timestamp, f text, g text, h text);
create index t_b on t (b);
create index t_f on t (f) where f::int > 0;
create view tv as select id, a, b from t;
create table child (id int primary key, t_a int);
alter table t add constraint t_a_uq unique (a);
alter table child add constraint child_fk foreign key (t_a) references t (a);
insert into t (id, a, b, c, d, e, f, g, h) values (1, 1, 'x', 'y', 1.5, now(), '42', 'g', '{a,b}');
