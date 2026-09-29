create table customers (id serial primary key, first_name text, lname text, email text);
create index customers_email_idx on customers (email);
create table invoices (id serial primary key, client_id int references customers(id), amount numeric);
create view customer_names as select id, first_name, lname from customers;
