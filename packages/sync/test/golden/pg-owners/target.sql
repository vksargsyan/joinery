do $$ begin if not exists (select from pg_roles where rolname = 'app_owner') then create role app_owner; end if; end $$;
do $$ begin if not exists (select from pg_roles where rolname = 'legacy_owner') then create role legacy_owner; end if; end $$;
create table owned (id int primary key);
alter table owned owner to legacy_owner;
create view owned_v as select id from owned;
alter view owned_v owner to legacy_owner;
