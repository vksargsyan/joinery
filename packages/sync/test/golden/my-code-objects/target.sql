CREATE TABLE `orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `total` decimal(10,2) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'new',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `sessions` (
  `id` char(36) NOT NULL,
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE VIEW `big_orders` AS SELECT id, total FROM orders WHERE total > 100;
CREATE VIEW `old_report` AS SELECT COUNT(*) AS n FROM orders;
DELIMITER ;;
CREATE PROCEDURE `archive_orders`(IN days INT)
BEGIN
  DELETE FROM orders WHERE created_at < NOW() - INTERVAL days DAY;
END;;
DELIMITER ;
CREATE FUNCTION `order_count`() RETURNS int READS SQL DATA RETURN (SELECT COUNT(*) FROM orders);
CREATE TRIGGER `orders_bi` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.status = 'new';
CREATE EVENT `purge_sessions` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 03:00:00' DO DELETE FROM sessions WHERE expires_at < NOW();
CREATE EVENT `nightly_stats` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 02:00:00' DO DELETE FROM sessions WHERE id IS NULL;
