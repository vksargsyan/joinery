create table clients (id serial primary key, fname text, lname text, email text);
create index clients_email_idx on clients (email);
create table invoices (id serial primary key, client_id int references clients(id), amount numeric);
create view client_names as select id, fname, lname from clients;
