create table notes (id int primary key, body text);
comment on table notes is 'old words';
comment on column notes.body is 'the text';
create view note_ids as select id from notes;
