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
CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `big_orders` AS SELECT id, total FROM orders WHERE total > 500;
CREATE VIEW `vip_orders` AS SELECT id FROM big_orders WHERE total > 1000;
DELIMITER ;;
CREATE PROCEDURE `archive_orders`(IN days INT)
BEGIN
  -- keep a week at least
  DELETE FROM orders WHERE created_at < NOW() - INTERVAL GREATEST(days, 7) DAY;
END;;
CREATE FUNCTION `order_total`(oid INT) RETURNS decimal(10,2)
    READS SQL DATA
BEGIN
  DECLARE t DECIMAL(10,2);
  SELECT total INTO t FROM orders WHERE id = oid;
  RETURN t;
END;;
CREATE TRIGGER `orders_bu` BEFORE UPDATE ON `orders` FOR EACH ROW
BEGIN
  IF NEW.total < 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'negative total';
  END IF;
END;;
DELIMITER ;
CREATE TRIGGER `orders_bi` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.status = 'pending';
CREATE EVENT `purge_sessions` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 03:00:00' DISABLE DO DELETE FROM sessions WHERE expires_at < NOW();
CREATE EVENT `nightly_stats` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 02:30:00' DO DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL 30 DAY;
