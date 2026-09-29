create type ticket_state as enum ('open', 'closed');
create type priority as enum ('low', 'high');
create table tickets (id serial primary key, state ticket_state not null default 'open', prio priority);
