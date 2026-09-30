CREATE TABLE t (
  id int NOT NULL PRIMARY KEY,
  doc json COMMENT 'old comment',
  qty int CHECK (qty >= 0),
  keep_json longtext CHECK (json_valid(keep_json)),
  plain int CHECK (plain <> 0),
  gone json,
  c2 int
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
