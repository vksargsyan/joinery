-- Joinery structure sync
-- Source: mariadb name_case_dev
-- Target: mariadb name_case_prod
-- Operations: 2 (1 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Drop column users.extra [destructive, not selected by default]
--   data-loss: Drops column users.extra and its data
ALTER TABLE `users` DROP COLUMN `extra`;

-- Alter column users.Name
ALTER TABLE `users` MODIFY COLUMN `name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

SET FOREIGN_KEY_CHECKS = 1;
