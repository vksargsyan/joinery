create schema core;
create schema report;
create table core.users (id int primary key, name text, team_id int);
create table report.teams (id int primary key, title text);
alter table core.users add constraint users_team_fk foreign key (team_id) references report.teams(id);
create view report.user_teams as select u.id, t.title from core.users u join report.teams t on t.id = u.team_id;
