CREATE TABLE a (id int NOT NULL, code varchar(10) NOT NULL, PRIMARY KEY (id), UNIQUE KEY uq_code (code));
CREATE TABLE b (id bigint unsigned NOT NULL, n int NOT NULL, PRIMARY KEY (id));
CREATE TABLE c (id int NOT NULL AUTO_INCREMENT, PRIMARY KEY (id));
INSERT INTO a VALUES (5, 'x'), (9, 'y');
CREATE TABLE d (id int NOT NULL, n int NOT NULL AUTO_INCREMENT, PRIMARY KEY (id), KEY k_n (n));
