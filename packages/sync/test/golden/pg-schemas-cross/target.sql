create schema a;
create schema old;
create table old.x (id int primary key);
create table a.t (id int primary key);
comment on schema a is 'old first';
