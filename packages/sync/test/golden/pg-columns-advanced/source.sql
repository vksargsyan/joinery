create table items (
  id int generated always as identity (start with 5 increment by 2),
  code text,
  qty int,
  price numeric not null default 0,
  total numeric generated always as (price * 2) stored,
  tag text collate "C",
  gen_old int,
  seq_id int generated always as identity
) with (fillfactor = 70, autovacuum_enabled = false);
