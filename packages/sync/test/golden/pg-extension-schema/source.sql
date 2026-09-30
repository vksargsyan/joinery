create schema ext;
create extension if not exists citext schema ext;
create extension if not exists pg_trgm;
create table t (id int primary key, email ext.citext, name text);
create index t_name_trgm on t using gin (name gin_trgm_ops);
