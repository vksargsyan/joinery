create table accounts (id int primary key, balance_cents bigint not null check (balance_cents >= 0), owner text);
create index accounts_balance on accounts (balance_cents) where balance_cents > 0;
create table ledger (id int primary key, account_id int references accounts (id));
create view rich as select id, balance_cents from accounts where balance_cents > 100000;
