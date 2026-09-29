-- Joinery structure sync
-- Source: mysql telemetry_dev
-- Target: mysql telemetry_prod
-- Operations: 7 (7 destructive)
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Drop table metrics_2019 [destructive, not selected by default]
--   data-loss: Drops table metrics_2019 and all of its rows
DROP TABLE `metrics_2019`;

-- Drop column metrics.raw [destructive, not selected by default]
--   data-loss: Drops column metrics.raw and its data
ALTER TABLE `metrics` DROP COLUMN `raw`;

-- Alter column metrics.kind [destructive, not selected by default]
--   data-loss: rows holding 'disk', 'net' lose their value
ALTER TABLE `metrics` MODIFY COLUMN `kind` enum('cpu','mem','gpu') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL;

-- Alter column metrics.value [destructive, not selected by default]
--   data-loss: float has less precision than double
ALTER TABLE `metrics` MODIFY COLUMN `value` float NOT NULL;

-- Alter column metrics.sampled_at [destructive, not selected by default]
--   data-loss: datetime rounds fractional seconds of datetime(6)
ALTER TABLE `metrics` MODIFY COLUMN `sampled_at` datetime NOT NULL;

-- Alter column metrics.host [destructive, not selected by default]
--   data-loss: Converting from utf8mb4 to latin1 can lose characters
ALTER TABLE `metrics` MODIFY COLUMN `host` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL;

-- Alter column metrics.counter [destructive, not selected by default]
--   data-loss: smallint is narrower than int
ALTER TABLE `metrics` MODIFY COLUMN `counter` smallint NOT NULL DEFAULT 0;

SET FOREIGN_KEY_CHECKS = 1;
