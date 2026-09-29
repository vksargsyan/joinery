create table docs (id int primary key, title text, body text, lang text, score int, constraint docs_score_check check (score >= 0), constraint docs_title_len check (length(title) < 200));
create index docs_title_lower_idx on docs (lower(title));
create index docs_lang on docs (lang, score desc nulls last) include (title) where lang <> 'xx';
create unique index docs_body_hash on docs (md5(body));
create index docs_score_brin on docs using brin (score);
comment on index docs_lang is 'language lookups';
