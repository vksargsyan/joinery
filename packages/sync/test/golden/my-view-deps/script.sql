-- Joinery structure sync
-- Source: mariadb view_deps_dev
-- Target: mariadb view_deps_prod
-- Operations: 6 (2 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Drop view v3 [destructive, not selected by default]
--   data-loss: Drops view v3
DROP VIEW `v3`;

-- Drop column t.c [destructive, not selected by default]
--   data-loss: Drops column t.c and its data
ALTER TABLE `t` DROP COLUMN `c`;

-- Alter column t.b
ALTER TABLE `t` MODIFY COLUMN `b` bigint(20);

-- Alter view v1
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v1` AS select `t`.`id` AS `id`,`t`.`b` AS `b` from `t`;

-- Alter view v2
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v2` AS select `v1`.`id` AS `id`,`v1`.`b` * 2 AS `b2` from `v1`;

-- Create view v0
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v0` AS select `v2`.`id` AS `id` from `v2`;

SET FOREIGN_KEY_CHECKS = 1;
