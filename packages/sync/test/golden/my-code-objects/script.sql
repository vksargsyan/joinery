-- Querybara structure sync
-- Source: mysql shop_dev
-- Target: mysql shop_prod
-- Operations: 10 (2 destructive)
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter trigger orders.orders_bi
DROP TRIGGER IF EXISTS `orders_bi`;

-- Drop view old_report [destructive, not selected by default]
--   data-loss: Drops view old_report
DROP VIEW `old_report`;

-- Drop routine order_count [destructive, not selected by default]
--   data-loss: Drops function order_count and its code
DROP FUNCTION IF EXISTS `order_count`;

-- Alter view big_orders
CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `big_orders` AS select `orders`.`id` AS `id`,`orders`.`total` AS `total` from `orders` where (`orders`.`total` > 500);

-- Create view vip_orders
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `vip_orders` AS select `big_orders`.`id` AS `id` from `big_orders` where (`big_orders`.`total` > 1000);

-- Alter routine archive_orders
DROP PROCEDURE IF EXISTS `archive_orders`;
DELIMITER $$
CREATE PROCEDURE `archive_orders`(IN days INT)
BEGIN
  -- keep a week at least
  DELETE FROM orders WHERE created_at < NOW() - INTERVAL GREATEST(days, 7) DAY;
END$$
DELIMITER ;

-- Create routine order_total
DELIMITER $$
CREATE FUNCTION `order_total`(oid INT) RETURNS decimal(10,2)
    READS SQL DATA
BEGIN
  DECLARE t DECIMAL(10,2);
  SELECT total INTO t FROM orders WHERE id = oid;
  RETURN t;
END$$
DELIMITER ;

-- Alter trigger orders.orders_bi (continued)
CREATE TRIGGER `orders_bi` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.status = 'pending';

-- Create trigger orders.orders_bu
DELIMITER $$
CREATE TRIGGER `orders_bu` BEFORE UPDATE ON `orders` FOR EACH ROW
BEGIN
  IF NEW.total < 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'negative total';
  END IF;
END$$
DELIMITER ;

-- Alter event nightly_stats
DROP EVENT IF EXISTS `nightly_stats`;
CREATE EVENT `nightly_stats` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 02:30:00' ON COMPLETION NOT PRESERVE ENABLE DO DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL 30 DAY;

-- Alter event purge_sessions
ALTER EVENT `purge_sessions` DISABLE;

SET FOREIGN_KEY_CHECKS = 1;
