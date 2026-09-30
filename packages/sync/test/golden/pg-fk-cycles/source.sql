create table keep (id int primary key);
create table authors (id int primary key, favourite_book int);
create table books (id int primary key, author_id int not null references authors(id), keep_id int references keep(id));
alter table authors add constraint authors_favourite_fk foreign key (favourite_book) references books(id) deferrable initially deferred;
