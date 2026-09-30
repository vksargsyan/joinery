create table t (id int primary key, v text);
create function audit_fn() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger t_audit after insert on t for each row execute function audit_fn();
create function fmt(x int) returns text language sql as $$ select x::text $$;
create view t_fmt as select id, fmt(id) as f from t;
