-- Querybara structure sync
-- Source: mysql billing
-- Target: mariadb billing
-- Operations: 2
-- Warning: Comparing mysql with mariadb: types, collations, defaults and functions differ between the families; review every statement
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Create column accounts.status
ALTER TABLE `accounts` ADD COLUMN `status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'open' AFTER `prefs`;

-- Create table audit
CREATE TABLE `audit` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `account_id` int NOT NULL,
  `detail` json NOT NULL,
  `at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
