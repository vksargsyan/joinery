CREATE TABLE t (
  id int NOT NULL PRIMARY KEY,
  doc json COMMENT 'new comment',
  qty int CHECK (qty > 0),
  keep_json longtext CHECK (json_valid(keep_json)),
  plain int,
  newcol int CHECK (newcol < 100),
  c2 int,
  CONSTRAINT two_cols CHECK (qty < c2)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE fresh (id int NOT NULL PRIMARY KEY, payload json, n int CHECK (n BETWEEN 1 AND 9), CHECK (n <> 5)) DEFAULT CHARSET=utf8mb4;
