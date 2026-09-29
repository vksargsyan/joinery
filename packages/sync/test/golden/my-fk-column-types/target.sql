CREATE TABLE parent (id int NOT NULL PRIMARY KEY, code varchar(20) NOT NULL, UNIQUE KEY uq_code (code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE child (id int NOT NULL PRIMARY KEY, parent_id int, parent_code varchar(20), KEY k_p (parent_id), KEY k_c (parent_code),
  CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent (id), CONSTRAINT fk_code FOREIGN KEY (parent_code) REFERENCES parent (code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO parent VALUES (1, 'a'); INSERT INTO child VALUES (1, 1, 'a');
