CREATE TABLE `products` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(200) NOT NULL,
  `sku` varchar(24) NOT NULL,
  `brand` varchar(60) DEFAULT NULL,
  `price` decimal(10,2) NOT NULL DEFAULT '0.00',
  `description` mediumtext COMMENT 'HTML allowed',
  `stock` int unsigned NOT NULL DEFAULT '0',
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  `notes` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
