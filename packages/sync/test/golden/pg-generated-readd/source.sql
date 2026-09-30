create table calc (id int primary key, a int, b int, s int generated always as (a * b) stored);
create index calc_s_idx on calc (s);
create table notes (id int primary key, body text not null default '');
