CREATE TABLE p (a int NOT NULL, name varchar(20), PRIMARY KEY (a)) ENGINE=InnoDB;
CREATE TABLE c (id int NOT NULL PRIMARY KEY, pa int, pb int, pname varchar(20), self_id int,
  KEY k_pab (pa), 
  CONSTRAINT fk_p FOREIGN KEY (pa) REFERENCES p (a)) ENGINE=InnoDB;
CREATE TABLE old_child (id int NOT NULL PRIMARY KEY, c_id int, CONSTRAINT fk_old FOREIGN KEY (c_id) REFERENCES c (id)) ENGINE=InnoDB;
