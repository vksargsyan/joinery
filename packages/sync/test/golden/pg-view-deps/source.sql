create table accounts (id int primary key, balance bigint not null, code varchar(10));
create view balances as select id, balance, code from accounts;
create view rich as select id, balance from balances where balance > 1000;
create view codes as select id, code from accounts;
