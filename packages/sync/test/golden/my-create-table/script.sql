-- Joinery structure sync
-- Source: mysql shop_dev
-- Target: mysql shop_prod
-- Operations: 4 (1 destructive)
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Drop table legacy_imports [destructive, not selected by default]
--   data-loss: Drops table legacy_imports and all of its rows
DROP TABLE `legacy_imports`;

-- Create table customers
CREATE TABLE `customers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(320) NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `status` enum('active','blocked') NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_customers_name` (`name`(32)),
  UNIQUE KEY `uq_customers_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='People who buy things';

-- Create table orders
CREATE TABLE `orders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `total` decimal(12,2) NOT NULL DEFAULT 0.00,
  `items` json,
  `item_count` int GENERATED ALWAYS AS (json_length(`items`)) VIRTUAL,
  `note` text,
  `placed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `fk_orders_customer` (`customer_id`),
  FULLTEXT KEY `ft_orders_note` (`note`),
  KEY `idx_orders_placed` (`placed_at` DESC),
  CONSTRAINT `orders_chk_1` CHECK (`total` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Create foreign key orders.fk_orders_customer
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE `orders` ADD CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE;

SET FOREIGN_KEY_CHECKS = 1;
