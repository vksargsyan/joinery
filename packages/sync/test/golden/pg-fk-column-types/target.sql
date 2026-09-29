create table parent (id int primary key, code varchar(20) unique not null);
create table child (id int primary key, parent_id int references parent (id), parent_code varchar(20) references parent (code));
insert into parent values (1, 'a'); insert into child values (1, 1, 'a');
