CREATE TABLE items (
  id int NOT NULL PRIMARY KEY,
  qty int NOT NULL DEFAULT 0,
  price decimal(10,2) NOT NULL DEFAULT 0,
  total decimal(12,2)
) DEFAULT CHARSET=utf8mb4;
CREATE TABLE item_log (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id int NOT NULL,
  qty int NOT NULL,
  logged_at datetime
) DEFAULT CHARSET=utf8mb4;
CREATE TRIGGER items_bi BEFORE INSERT ON items FOR EACH ROW SET NEW.total = NEW.qty * NEW.price;
DELIMITER ;;
CREATE TRIGGER items_bu BEFORE UPDATE ON items FOR EACH ROW
BEGIN
  IF NEW.qty < 0 THEN
    SET NEW.qty = 0;
  END IF;
  SET NEW.total = NEW.qty * NEW.price;
END;;
DELIMITER ;
CREATE TRIGGER items_ai AFTER INSERT ON items FOR EACH ROW INSERT INTO item_log (item_id, qty) VALUES (NEW.id, NEW.qty);
CREATE TRIGGER item_log_bi BEFORE INSERT ON item_log FOR EACH ROW SET NEW.logged_at = COALESCE(NEW.logged_at, '2000-01-01 00:00:00');
