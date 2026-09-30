CREATE TABLE i (id int NOT NULL PRIMARY KEY, a varchar(100), b int, c text, g point NOT NULL, d datetime,
  KEY k_ab (a(10), b), KEY uq_b (b), KEY k_d (d)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE m (id int NOT NULL, v int, PRIMARY KEY (id), KEY k_hash (v) USING BTREE) ENGINE=MEMORY;
