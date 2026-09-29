-- Joinery structure sync
-- Source: mariadb routines_events_dev
-- Target: mariadb routines_events_prod
-- Operations: 8 (1 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter trigger acc.acc_ai
DROP TRIGGER IF EXISTS `acc_ai`;

-- Alter column acc.bal [destructive, not selected by default]
--   data-loss: decimal(10,2) holds fewer integer digits than decimal(12,2)
ALTER TABLE `acc` MODIFY COLUMN `bal` decimal(10,2) NOT NULL DEFAULT 0.00;

-- Alter view v_acc
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v_acc` AS select `acc`.`id` AS `id`,`acc`.`bal` AS `bal` from `acc` where `acc`.`bal` > 0 WITH CASCADED CHECK OPTION;

-- Alter view v_owner
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_owner` AS select `acc`.`owner` AS `owner`,'it\'s' AS `lit`,count(0) AS `n` from `acc` group by `acc`.`owner`;

-- Alter routine audit_all
DROP PROCEDURE IF EXISTS `audit_all`;
DELIMITER $$
CREATE PROCEDURE `audit_all`(IN p_note varchar(100), OUT p_n int)
    MODIFIES SQL DATA
    COMMENT 'audits'
BEGIN
  DECLARE done int DEFAULT 0;
  INSERT INTO log (msg) VALUES (CONCAT('audit; ', p_note));
  SELECT COUNT(*) INTO p_n FROM acc;
END$$
DELIMITER ;

-- Alter routine fee
DROP FUNCTION IF EXISTS `fee`;
CREATE FUNCTION `fee`(x decimal(10,2)) RETURNS decimal(10,2)
    DETERMINISTIC
    COMMENT 'fee ''calc'''
RETURN x * 0.02;

-- Alter trigger acc.acc_ai (continued)
DELIMITER $$
CREATE TRIGGER acc_ai AFTER INSERT ON acc FOR EACH ROW
BEGIN
  INSERT INTO log (msg) VALUES (CONCAT('new ', NEW.id, ';'));
END$$
DELIMITER ;

-- Create trigger acc.acc_bu
CREATE TRIGGER acc_bu BEFORE UPDATE ON acc FOR EACH ROW
SET NEW.bal = GREATEST(NEW.bal, 0);

-- Alter event ev1
DROP EVENT IF EXISTS `ev1`;
CREATE EVENT `ev1` ON SCHEDULE EVERY 2 HOUR STARTS '2030-01-01 00:00:00' ON COMPLETION PRESERVE DISABLE COMMENT 'ev' DO DELETE FROM log WHERE id < 0;

SET FOREIGN_KEY_CHECKS = 1;
