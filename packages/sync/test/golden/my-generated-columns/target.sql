CREATE TABLE g (
  id int NOT NULL PRIMARY KEY,
  moved int,
  a int,
  b int,
  v int AS (a - b) VIRTUAL,
  s int AS (a * b) VIRTUAL,
  name varchar(20),
  upper_name varchar(20),
  KEY k_v (v)
) DEFAULT CHARSET=utf8mb4;
CREATE TABLE r (id int NOT NULL PRIMARY KEY, fname varchar(30), last varchar(40)) DEFAULT CHARSET=utf8mb4;
