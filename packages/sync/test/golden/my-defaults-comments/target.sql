CREATE TABLE d (
  id int NOT NULL AUTO_INCREMENT,
  s varchar(50) NOT NULL,
  e enum('a','b''c','d'),
  st set('x','y'),
  b bit(3),
  f float,
  dt datetime(3),
  ts timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  u varchar(36),
  n decimal(10,3),
  bin varbinary(4),
  txt text,
  c varchar(20),
  y year,
  dd date,
  expr int,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
