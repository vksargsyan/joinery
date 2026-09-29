create table parents (id int primary key, code text not null unique, region text);
create table children (id int primary key, parent_id int references parents(id), parent_code text references parents(code));
