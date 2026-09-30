create table t (id int primary key, v int, w text, updated timestamptz);
create function trg() returns trigger language plpgsql as $$ begin new.updated := now(); return new; end $$;
create function trg_stmt() returns trigger language plpgsql as $$ begin return null; end $$;
create trigger t_upd before update of v, w on t for each row when (old.v is distinct from new.v) execute function trg();
create trigger t_stmt after insert or delete on t for each statement execute function trg_stmt();
create trigger t_trunc after truncate on t for each statement execute function trg_stmt();
create table u (id int primary key, t_id int references t(id) deferrable);
create constraint trigger u_ct after insert on u deferrable initially deferred for each row execute function trg_stmt();
create view tv as select id, v from t;
