create table h (id int not null, v text) partition by hash (id);
create table h0 partition of h for values with (modulus 2, remainder 0);
create table h1 partition of h for values with (modulus 2, remainder 1);
create table l (region text not null, n int) partition by list (region);
create table l_eu partition of l for values in ('de', 'fr');
create table l_old partition of l for values in ('xx');
create table r (d date not null, id int not null, primary key (d, id)) partition by range (d);
create table r_2023 partition of r for values from ('2023-01-01') to ('2024-01-01');
