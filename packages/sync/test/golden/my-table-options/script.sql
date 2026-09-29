-- Joinery structure sync
-- Source: mariadb table_options_dev
-- Target: mariadb table_options_prod
-- Operations: 5 (1 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter column a.t
ALTER TABLE `a` MODIFY COLUMN `t` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

-- Alter column b.t [destructive, not selected by default]
--   data-loss: Converting from utf8mb4 to latin1 can lose characters
ALTER TABLE `b` MODIFY COLUMN `t` text CHARACTER SET latin1 COLLATE latin1_swedish_ci;

-- Alter table a
--   info: Changing the engine rebuilds the table
ALTER TABLE `a` ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci ROW_FORMAT=DYNAMIC COMMENT='new';

-- Alter table b
ALTER TABLE `b` DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

-- Alter table m
--   info: Changing the engine rebuilds the table
ALTER TABLE `m` ENGINE=MyISAM;

SET FOREIGN_KEY_CHECKS = 1;
