CREATE TABLE `customers` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB;
CREATE TABLE `warehouses` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB;
CREATE TABLE `orders` (
  `id` int NOT NULL,
  `customer_id` int NOT NULL,
  `warehouse_id` int DEFAULT NULL,
  `qty` int NOT NULL,
  `price` decimal(10,2) NOT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`id`),
  FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CHECK ((`qty` > 0)),
  CHECK ((`price` >= 0))
) ENGINE=InnoDB;
