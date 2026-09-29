create table regions (id int primary key, code varchar(8) not null, zone int not null default 0, constraint regions_code_key unique (code, zone));
create table shops (id int primary key, region_code varchar(8), region_zone int, foreign key (region_code, region_zone) references regions(code, zone));
