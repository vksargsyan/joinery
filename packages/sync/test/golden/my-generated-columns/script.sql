-- Joinery structure sync
-- Source: mariadb generated_columns_dev
-- Target: mariadb generated_columns_prod
-- Operations: 5
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter column g.v
ALTER TABLE `g` MODIFY COLUMN `v` int(11) GENERATED ALWAYS AS (`a` + `b`) VIRTUAL;

-- Alter column g.upper_name
ALTER TABLE `g` MODIFY COLUMN `upper_name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS (ucase(`name`)) STORED;

-- Alter column r.first_name
--   may-fail: SET NOT NULL fails if the column holds NULLs
ALTER TABLE `r` CHANGE COLUMN `fname` `first_name` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '';

-- Alter column g.s
--   info: The column is dropped and re-added; indexes and checks on it are re-created after it
ALTER TABLE `g` DROP COLUMN `s`;
ALTER TABLE `g` ADD COLUMN `s` int(11) GENERATED ALWAYS AS (`a` * `b`) STORED AFTER `v`;

-- Alter column g.moved
ALTER TABLE `g` MODIFY COLUMN `moved` int(11) AFTER `upper_name`;

SET FOREIGN_KEY_CHECKS = 1;
