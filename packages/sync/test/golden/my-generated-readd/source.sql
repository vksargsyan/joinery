CREATE TABLE g (
  id int NOT NULL PRIMARY KEY,
  a int,
  b int,
  s int AS (a * b) STORED,
  w int AS (a - b) VIRTUAL,
  p int,
  KEY k_multi (a, s),
  KEY k_s (s),
  KEY k_w (w, a),
  CONSTRAINT s_pos CHECK (s >= -100),
  CONSTRAINT w_chk CHECK (w < 1000 AND a > -5)
) DEFAULT CHARSET=utf8mb4;
