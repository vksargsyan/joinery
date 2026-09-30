create table t (id int primary key, a text, b int, j jsonb, ts tstzrange, c text collate "C");
create index t_a_pattern on t (a);
create index t_j_gin on t using gin (j);
create unique index t_ab_uq on t (a, b);
create index t_lower on t (lower(a));
create index t_c on t (c) where c > 'a';
