create type color as enum ('blue', 'green', 'red');
create table paints (id int primary key, c color not null default 'red', palette color[]);
create view reds as select id, c from paints where c = 'red';
