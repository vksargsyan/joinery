-- Querybara structure sync
-- Source: mariadb iot
-- Target: mysql iot
-- Operations: 2
-- Warning: Comparing mariadb with mysql: types, collations, defaults and functions differ between the families; review every statement
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Create table devices
--   cross-family: MariaDB collation utf8mb4_uca1400_ai_ci does not exist on MySQL
--   cross-family: MariaDB type uuid does not exist on MySQL
CREATE TABLE `devices` (
  `id` uuid NOT NULL,
  `serial` bigint(20) unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `meta` json,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

SET FOREIGN_KEY_CHECKS = 1;
-- Not scripted (change these manually):
--   Create sequence device_seq [not selected by default]: MySQL has no sequences
