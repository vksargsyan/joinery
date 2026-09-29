create table a_old (id int primary key, b_id int);
create table b_old (id int primary key, a_id int references a_old(id));
alter table a_old add constraint a_old_b_fk foreign key (b_id) references b_old(id);
create table keep (id int primary key);
