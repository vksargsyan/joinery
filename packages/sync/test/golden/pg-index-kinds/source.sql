create table t (id int primary key, a text, b int, j jsonb, ts tstzrange, c text collate "C");
create index t_a_pattern on t (a text_pattern_ops);
create index t_j_gin on t using gin (j jsonb_path_ops);
create index t_ts_gist on t using gist (ts);
create unique index t_ab_uq on t (a, b) where b > 0;
create index t_lower on t (lower(a) collate "C" desc nulls first) include (b) where b is not null and a <> '';
create index t_hash on t using hash (b);
create index t_c on t (c);
alter table t add constraint t_b_uq unique (b) include (a);
