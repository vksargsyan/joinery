create type ticket_state as enum ('new', 'open', 'waiting', 'closed', 'archived');
create type priority as enum ('low', 'medium', 'high');
create table tickets (id serial primary key, state ticket_state not null default 'new', prio priority default 'medium');
