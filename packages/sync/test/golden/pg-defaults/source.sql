create extension if not exists pgcrypto;
create table d (
  id uuid primary key default gen_random_uuid(),
  a int default -1,
  b numeric(10,2) default 1.50,
  c text default 'x',
  dt date default current_date,
  ts timestamp default (now() at time zone 'utc'),
  iv interval default '1 day',
  j jsonb default '{"a": [1, 2]}',
  arr int[] default '{}',
  arr2 text[] default array['a', 'b'],
  f float8 default 'NaN',
  bits bit(3) default b'101',
  bo boolean default false,
  expr int default (1 + 2) * 3,
  money_col money default 12.5,
  ch char(3) default 'ab',
  vc varchar(10) default 'x'::character varying,
  tz timestamptz default '2024-01-01 00:00:00+00'
);
