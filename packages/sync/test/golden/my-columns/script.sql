-- Joinery structure sync
-- Source: mysql shop_dev
-- Target: mysql shop_prod
-- Operations: 9 (3 destructive)
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Drop column products.legacy_flag [destructive, not selected by default]
--   data-loss: Drops column products.legacy_flag and its data
ALTER TABLE `products` DROP COLUMN `legacy_flag`;

-- Alter column products.title
ALTER TABLE `products` MODIFY COLUMN `title` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL;

-- Alter column products.sku [destructive, not selected by default]
--   data-loss: varchar(24) is shorter than varchar(32)
ALTER TABLE `products` MODIFY COLUMN `sku` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL AFTER `title`;

-- Create column products.brand
ALTER TABLE `products` ADD COLUMN `brand` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci AFTER `sku`;

-- Alter column products.price
--   may-fail: SET NOT NULL fails if the column holds NULLs
ALTER TABLE `products` MODIFY COLUMN `price` decimal(10,2) NOT NULL DEFAULT 0.00;

-- Alter column products.description
ALTER TABLE `products` MODIFY COLUMN `description` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci COMMENT 'HTML allowed';

-- Alter column products.stock [destructive, not selected by default]
--   data-loss: int unsigned cannot hold negative values
ALTER TABLE `products` MODIFY COLUMN `stock` int unsigned NOT NULL DEFAULT 0;

-- Alter column products.updated_at
ALTER TABLE `products` MODIFY COLUMN `updated_at` timestamp NULL ON UPDATE CURRENT_TIMESTAMP;

-- Alter column products.notes
ALTER TABLE `products` MODIFY COLUMN `notes` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

SET FOREIGN_KEY_CHECKS = 1;
