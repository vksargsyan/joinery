create table parent (id bigint primary key, code varchar(40) unique not null);
create table child (id int primary key, parent_id bigint references parent (id), parent_code varchar(40) references parent (code));
