CREATE TABLE items (
  id int NOT NULL PRIMARY KEY,
  quantity int NOT NULL DEFAULT 0,
  price decimal(10,2) NOT NULL DEFAULT 0,
  total decimal(12,2)
) DEFAULT CHARSET=utf8mb4;
CREATE TABLE item_history (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id int NOT NULL,
  quantity int NOT NULL,
  logged_at datetime
) DEFAULT CHARSET=utf8mb4;
CREATE TRIGGER items_bi BEFORE INSERT ON items FOR EACH ROW SET NEW.total = NEW.quantity * NEW.price;
DELIMITER ;;
CREATE TRIGGER items_bu BEFORE UPDATE ON items FOR EACH ROW
BEGIN
  IF NEW.quantity < 0 THEN
    SET NEW.quantity = 0;
  END IF;
  SET NEW.total = NEW.quantity * NEW.price;
END;;
DELIMITER ;
CREATE TRIGGER items_ai AFTER INSERT ON items FOR EACH ROW INSERT INTO item_history (item_id, quantity) VALUES (NEW.id, NEW.quantity);
CREATE TRIGGER item_log_bi BEFORE INSERT ON item_history FOR EACH ROW SET NEW.logged_at = COALESCE(NEW.logged_at, '2000-01-01 00:00:00');
