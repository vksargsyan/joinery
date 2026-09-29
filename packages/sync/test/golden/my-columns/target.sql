CREATE TABLE `products` (
  `id` int NOT NULL AUTO_INCREMENT,
  `sku` varchar(32) NOT NULL,
  `title` varchar(100) NOT NULL,
  `price` decimal(8,2) DEFAULT NULL,
  `legacy_flag` tinyint(1) NOT NULL DEFAULT '0',
  `description` text,
  `stock` int NOT NULL DEFAULT '0',
  `updated_at` timestamp NULL DEFAULT NULL,
  `notes` varchar(500) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
