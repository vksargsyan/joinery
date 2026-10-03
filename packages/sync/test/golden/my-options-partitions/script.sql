-- Querybara structure sync
-- Source: mysql audit_dev
-- Target: mysql audit_prod
-- Operations: 4
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter column events_log.message
ALTER TABLE `events_log` MODIFY COLUMN `message` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL;

-- Alter partition archive
--   may-fail: Repartitioning rebuilds the table and fails if rows fall outside every partition
ALTER TABLE `archive` PARTITION BY RANGE (`year`)
(PARTITION `p2023` VALUES LESS THAN (2024),
 PARTITION `p2024` VALUES LESS THAN (2025),
 PARTITION `pmax` VALUES LESS THAN MAXVALUE);

-- Alter table events_log
--   info: Changing the engine rebuilds the table
ALTER TABLE `events_log` ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC AUTO_INCREMENT=1000 COMMENT='Audit trail';

-- Alter partition hashed
--   may-fail: Repartitioning rebuilds the table and fails if rows fall outside every partition
ALTER TABLE `hashed` REMOVE PARTITIONING;

SET FOREIGN_KEY_CHECKS = 1;
