create table docs (id int primary key, title text, body text, lang text, score int, constraint docs_score_chk check (score >= 0));
create index docs_title_idx on docs (title);
create index docs_lang on docs (lang) where lang is not null;
create index docs_old on docs (score);
