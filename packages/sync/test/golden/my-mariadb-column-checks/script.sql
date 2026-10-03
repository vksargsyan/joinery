-- Querybara structure sync
-- Source: mariadb mariadb_column_checks_dev
-- Target: mariadb mariadb_column_checks_prod
-- Operations: 7 (1 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Drop column t.gone [destructive, not selected by default]
--   data-loss: Drops column t.gone and its data
ALTER TABLE `t` DROP COLUMN `gone`;

-- Alter column t.doc
ALTER TABLE `t` MODIFY COLUMN `doc` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'new comment' CHECK (json_valid(`doc`));

-- Alter column t.qty
--   may-fail: Adding the check fails if existing rows violate it
ALTER TABLE `t` MODIFY COLUMN `qty` int(11) CHECK (`qty` > 0);

-- Alter column t.plain
ALTER TABLE `t` MODIFY COLUMN `plain` int(11);

-- Create column t.newcol
ALTER TABLE `t` ADD COLUMN `newcol` int(11) CHECK (`newcol` < 100) AFTER `plain`;

-- Create check t.two_cols
--   may-fail: Adding the check fails if existing rows violate it
ALTER TABLE `t` ADD CONSTRAINT `two_cols` CHECK (`qty` < `c2`);

-- Create table fresh
CREATE TABLE `fresh` (
  `id` int(11) NOT NULL,
  `payload` longtext COLLATE utf8mb4_bin CHECK (json_valid(`payload`)),
  `n` int(11) CHECK (`n` between 1 and 9),
  PRIMARY KEY (`id`),
  CONSTRAINT `CONSTRAINT_1` CHECK (`n` <> 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET FOREIGN_KEY_CHECKS = 1;
