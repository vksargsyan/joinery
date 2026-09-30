create table users (id int primary key, name text, extra int);
create index users_name_idx on users (name);
