-- Querybara structure sync
-- Source: mariadb charsets_dev
-- Target: mariadb charsets_prod
-- Operations: 7 (2 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter column t1.a
ALTER TABLE `t1` MODIFY COLUMN `a` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Alter column t1.b
ALTER TABLE `t1` MODIFY COLUMN `b` varchar(20) CHARACTER SET latin1 COLLATE latin1_general_ci;

-- Alter column t1.c
ALTER TABLE `t1` MODIFY COLUMN `c` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- Alter column t1.e [destructive, not selected by default]
--   data-loss: Converting from latin1 to ascii can lose characters
ALTER TABLE `t1` MODIFY COLUMN `e` enum('x','y') CHARACTER SET ascii COLLATE ascii_general_ci;

-- Alter column t2.a [destructive, not selected by default]
--   data-loss: Converting from utf8mb4 to utf8mb3 can lose characters
ALTER TABLE `t2` MODIFY COLUMN `a` varchar(20) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci;

-- Alter table t1
ALTER TABLE `t1` DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Alter table t2
ALTER TABLE `t2` DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

SET FOREIGN_KEY_CHECKS = 1;
