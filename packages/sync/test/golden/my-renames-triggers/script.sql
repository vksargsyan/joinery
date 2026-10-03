-- Querybara structure sync
-- Source: mysql renames_triggers_dev
-- Target: mysql renames_triggers_prod
-- Operations: 6
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter trigger items.items_ai
-- Re-created because its body uses a renamed column or table
DROP TRIGGER IF EXISTS `items_ai`;

-- Alter trigger items.items_bi
-- Re-created because its body uses a renamed column or table
DROP TRIGGER IF EXISTS `items_bi`;

-- Alter trigger items.items_bu
-- Re-created because its body uses a renamed column or table
DROP TRIGGER IF EXISTS `items_bu`;

-- Rename table item_history
RENAME TABLE `item_log` TO `item_history`;

-- Rename column item_history.quantity
ALTER TABLE `item_history` CHANGE COLUMN `qty` `quantity` int NOT NULL;

-- Rename column items.quantity
ALTER TABLE `items` CHANGE COLUMN `qty` `quantity` int NOT NULL DEFAULT 0;

-- Alter trigger items.items_ai (continued)
CREATE TRIGGER `items_ai` AFTER INSERT ON `items` FOR EACH ROW INSERT INTO item_history (item_id, quantity) VALUES (NEW.id, NEW.quantity);

-- Alter trigger items.items_bi (continued)
CREATE TRIGGER `items_bi` BEFORE INSERT ON `items` FOR EACH ROW SET NEW.total = NEW.quantity * NEW.price;

-- Alter trigger items.items_bu (continued)
DELIMITER $$
CREATE TRIGGER `items_bu` BEFORE UPDATE ON `items` FOR EACH ROW BEGIN
  IF NEW.quantity < 0 THEN
    SET NEW.quantity = 0;
  END IF;
  SET NEW.total = NEW.quantity * NEW.price;
END$$
DELIMITER ;

SET FOREIGN_KEY_CHECKS = 1;
