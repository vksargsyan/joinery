create table p (id int, code text, constraint p_primary primary key (id), constraint uq_code unique (code), constraint positive check (id > 0));
create table c (id int primary key, p_id int, constraint c_parent foreign key (p_id) references p(id));
create index c_idx_parent on c (p_id);
