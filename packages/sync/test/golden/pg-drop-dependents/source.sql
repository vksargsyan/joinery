create table a (id int primary key, keep text);
create view av as select id, keep from a;
create table c (id int primary key);
