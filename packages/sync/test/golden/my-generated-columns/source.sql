CREATE TABLE g (
  id int NOT NULL PRIMARY KEY,
  a int,
  b int,
  v int AS (a + b) VIRTUAL,
  s int AS (a * b) STORED,
  name varchar(20),
  upper_name varchar(20) AS (upper(name)) STORED,
  moved int,
  KEY k_v (v)
) DEFAULT CHARSET=utf8mb4;
CREATE TABLE r (id int NOT NULL PRIMARY KEY, first_name varchar(40) NOT NULL DEFAULT '', last varchar(40)) DEFAULT CHARSET=utf8mb4;
