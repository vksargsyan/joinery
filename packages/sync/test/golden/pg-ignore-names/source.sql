create table p (id int primary key, code text unique check (id > 0));
create table c (id int primary key, p_id int references p(id));
create index on c (p_id);
