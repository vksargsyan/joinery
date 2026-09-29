CREATE TABLE t1 (id int NOT NULL PRIMARY KEY, a varchar(20), b varchar(20) CHARACTER SET latin1 COLLATE latin1_general_ci, c text COLLATE utf8mb4_bin, e enum('x','y') CHARACTER SET ascii) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE t2 (id int NOT NULL PRIMARY KEY, a varchar(20)) DEFAULT CHARSET=utf8mb3;
