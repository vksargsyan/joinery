create table wallets (id int primary key, balance int not null check (balance >= 0), owner text);
create index wallets_balance on wallets (balance) where balance > 0;
create table ledger (id int primary key, account_id int references wallets (id));
create view rich as select id, balance from wallets where balance > 100000;
