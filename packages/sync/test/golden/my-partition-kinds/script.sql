-- Joinery structure sync
-- Source: mariadb partition_kinds_dev
-- Target: mariadb partition_kinds_prod
-- Operations: 5
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter partition addp
--   may-fail: Repartitioning rebuilds the table and fails if rows fall outside every partition
ALTER TABLE `addp` PARTITION BY KEY (`id`) PARTITIONS 3;

-- Alter partition h1
--   may-fail: Repartitioning rebuilds the table and fails if rows fall outside every partition
ALTER TABLE `h1` PARTITION BY HASH (`id`) PARTITIONS 4;

-- Alter partition l1
--   may-fail: Repartitioning rebuilds the table and fails if rows fall outside every partition
ALTER TABLE `l1` PARTITION BY LIST (`region`)
(PARTITION `pa` VALUES IN (1,2,3),
 PARTITION `pb` VALUES IN (4,5));

-- Alter partition np
--   may-fail: Repartitioning rebuilds the table and fails if rows fall outside every partition
ALTER TABLE `np` REMOVE PARTITIONING;

-- Alter partition r1
--   may-fail: Repartitioning rebuilds the table and fails if rows fall outside every partition
ALTER TABLE `r1` PARTITION BY RANGE (`y`)
(PARTITION `p1` VALUES LESS THAN (2000),
 PARTITION `p2` VALUES LESS THAN (2010),
 PARTITION `p3` VALUES LESS THAN (2020),
 PARTITION `pmax` VALUES LESS THAN MAXVALUE);

SET FOREIGN_KEY_CHECKS = 1;
