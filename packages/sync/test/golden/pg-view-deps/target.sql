create table accounts (id int primary key, balance integer not null, code varchar(10), obsolete text);
create view balances as select id, balance, code from accounts;
create view rich as select id, balance from balances where balance > 1000;
create view codes as select id, code from accounts;
create view obsolete_view as select id, obsolete from accounts;
