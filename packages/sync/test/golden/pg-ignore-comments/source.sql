create table notes (id int primary key, body text, pinned boolean not null default false);
comment on table notes is 'new words';
create view note_ids as select id from notes;
comment on view note_ids is 'ids only';
