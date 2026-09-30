create table parents (id int not null, code text not null unique, region text not null default 'eu', primary key (id, region));
create table children (id int primary key, parent_id int, parent_code text references parents(code));
