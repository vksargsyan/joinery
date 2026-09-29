create table p (a int, b int, c text unique, primary key (a, b));
create table ch (id int primary key, pa int, pb int, pc text, self int,
  constraint ch_p foreign key (pa, pb) references p (a, b) match full on update cascade on delete set default deferrable initially deferred,
  constraint ch_c foreign key (pc) references p (c) on delete restrict,
  constraint ch_self foreign key (self) references ch (id) on delete cascade deferrable);
