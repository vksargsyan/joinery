CREATE TABLE clients (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, name varchar(80) NOT NULL, email varchar(100), KEY idx_name (name), UNIQUE KEY email (email)) DEFAULT CHARSET=utf8mb4;
CREATE TABLE orders (id int NOT NULL PRIMARY KEY, customer_id int, KEY k_c (customer_id), CONSTRAINT fk_orders_client FOREIGN KEY (customer_id) REFERENCES clients (id)) DEFAULT CHARSET=utf8mb4;
CREATE VIEW v_names AS SELECT id, name AS full_name FROM clients;
CREATE TRIGGER clients_bi BEFORE INSERT ON clients FOR EACH ROW SET NEW.name = TRIM(NEW.name);
