create table p (a int, b int, c text unique, primary key (a, b));
create table ch (id int primary key, pa int, pb int, pc text, self int,
  constraint ch_p foreign key (pa, pb) references p (a, b),
  constraint ch_c foreign key (pc) references p (c),
  constraint ch_self foreign key (self) references ch (id));
