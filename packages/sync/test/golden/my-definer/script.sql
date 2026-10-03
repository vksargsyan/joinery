-- Querybara structure sync
-- Source: mysql ops_dev
-- Target: mysql ops_prod
-- Operations: 2
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter view v_t
CREATE OR REPLACE ALGORITHM=UNDEFINED DEFINER=`app`@`%` SQL SECURITY DEFINER VIEW `v_t` AS select `t`.`id` AS `id` from `t`;

-- Alter routine p_count
DROP PROCEDURE IF EXISTS `p_count`;
CREATE DEFINER=`app`@`%` PROCEDURE `p_count`()
SELECT COUNT(*) FROM t;

SET FOREIGN_KEY_CHECKS = 1;
