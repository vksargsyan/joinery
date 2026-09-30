-- Joinery structure sync
-- Source: mysql wms_dev
-- Target: mysql wms_prod
-- Operations: 3
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Create index orders.warehouse_id
ALTER TABLE `orders` ADD KEY (`warehouse_id`);

-- Create check orders.orders_chk_1
--   may-fail: Adding the check fails if existing rows violate it
ALTER TABLE `orders` ADD CHECK (`qty` > 0);

-- Create foreign key orders.orders_ibfk_1
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE `orders` ADD FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`id`);

SET FOREIGN_KEY_CHECKS = 1;
