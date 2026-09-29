-- Joinery structure sync
-- Source: mariadb renames_deps_dev
-- Target: mariadb renames_deps_prod
-- Operations: 9 (1 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Drop foreign key orders.fk_orders_client
ALTER TABLE `orders` DROP FOREIGN KEY `fk_orders_client`;

-- Drop trigger customers.clients_bi [destructive, not selected by default]
--   data-loss: Drops trigger clients_bi and its code
DROP TRIGGER IF EXISTS `clients_bi`;

-- Rename table customers
RENAME TABLE `clients` TO `customers`;

-- Rename index customers.idx_full_name
ALTER TABLE `customers` RENAME INDEX `idx_name` TO `idx_full_name`;

-- Rename index customers.uq_email
ALTER TABLE `customers` RENAME INDEX `email` TO `uq_email`;

-- Rename column customers.full_name
ALTER TABLE `customers` CHANGE COLUMN `name` `full_name` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

-- Create foreign key orders.fk_orders_customer
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE `orders` ADD CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Alter view v_names
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v_names` AS select `customers`.`id` AS `id`,`customers`.`full_name` AS `full_name` from `customers`;

-- Create trigger customers.customers_bi
CREATE TRIGGER customers_bi BEFORE INSERT ON customers FOR EACH ROW SET NEW.full_name = TRIM(NEW.full_name);

SET FOREIGN_KEY_CHECKS = 1;
