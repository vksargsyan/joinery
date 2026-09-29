CREATE TABLE p (a int NOT NULL, b int NOT NULL, name varchar(20), PRIMARY KEY (a, b), UNIQUE KEY uq_name (name)) ENGINE=InnoDB;
CREATE TABLE c (id int NOT NULL PRIMARY KEY, pa int, pb int, pname varchar(20), self_id int,
  KEY k_pab (pa, pb), KEY k_self (self_id),
  CONSTRAINT fk_p FOREIGN KEY (pa, pb) REFERENCES p (a, b) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_name FOREIGN KEY (pname) REFERENCES p (name),
  CONSTRAINT fk_self FOREIGN KEY (self_id) REFERENCES c (id) ON DELETE CASCADE) ENGINE=InnoDB;
CREATE TABLE newbie (id int NOT NULL PRIMARY KEY, c_id int, CONSTRAINT fk_new FOREIGN KEY (c_id) REFERENCES c (id)) ENGINE=InnoDB;
