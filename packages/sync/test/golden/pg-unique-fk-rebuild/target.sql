create table regions (id int primary key, code varchar(8) not null, zone int not null default 0, constraint regions_code_key unique (zone, code), constraint regions_code_only unique (code));
create table shops (id int primary key, region_code varchar(8), region_zone int, foreign key (region_code, region_zone) references regions(code, zone));
create table kiosks (id int primary key, region_code varchar(8) references regions(code));
