CREATE TABLE i (id int NOT NULL PRIMARY KEY, a varchar(100), b int, c text, g point NOT NULL, d datetime,
  KEY k_ab (a(20), b DESC), UNIQUE KEY uq_b (b), FULLTEXT KEY ft_c (c), SPATIAL KEY sp_g (g), KEY k_d (d) COMMENT 'dates') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE m (id int NOT NULL, v int, PRIMARY KEY (id), KEY k_hash (v) USING HASH) ENGINE=MEMORY;
