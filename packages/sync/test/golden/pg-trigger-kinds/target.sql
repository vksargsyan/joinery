create table t (id int primary key, v int, w text, updated timestamptz);
create function trg() returns trigger language plpgsql as $$ begin new.updated := clock_timestamp(); return new; end $$;
create trigger t_upd before update on t for each row execute function trg();
create trigger t_old after update on t for each row execute function trg();
create table u (id int primary key, t_id int references t(id));
create view tv as select id, v from t;
