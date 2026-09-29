create table accounts (id int primary key, email text, region text);
create view eu_accounts as select id, email, region from accounts where region = 'eu';
create view secure_accounts with (security_barrier = true) as select id from accounts;
