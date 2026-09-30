CREATE TABLE customers (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, full_name varchar(80) NOT NULL, email varchar(100), KEY idx_full_name (full_name), UNIQUE KEY uq_email (email)) DEFAULT CHARSET=utf8mb4;
CREATE TABLE orders (id int NOT NULL PRIMARY KEY, customer_id int, KEY k_c (customer_id), CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)) DEFAULT CHARSET=utf8mb4;
CREATE VIEW v_names AS SELECT id, full_name FROM customers;
CREATE TRIGGER customers_bi BEFORE INSERT ON customers FOR EACH ROW SET NEW.full_name = TRIM(NEW.full_name);
