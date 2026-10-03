-- Querybara structure sync
-- Source: mysql crm_dev
-- Target: mysql crm_prod
-- Operations: 4
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Rename table customers
RENAME TABLE `clients` TO `customers`;

-- Alter view customer_emails
RENAME TABLE `client_emails` TO `customer_emails`;

-- Rename index customers.idx_customers_email
ALTER TABLE `customers` RENAME INDEX `idx_email` TO `idx_customers_email`;

-- Alter column customers.first_name
ALTER TABLE `customers` CHANGE COLUMN `fname` `first_name` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL;

-- Alter view customer_emails (continued)
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `customer_emails` AS select `customers`.`id` AS `id`,`customers`.`email` AS `email` from `customers`;

SET FOREIGN_KEY_CHECKS = 1;
