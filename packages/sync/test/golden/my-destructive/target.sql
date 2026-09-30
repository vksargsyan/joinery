CREATE TABLE `metrics` (
  `id` bigint NOT NULL,
  `kind` enum('cpu','mem','disk','net') NOT NULL,
  `value` double NOT NULL,
  `sampled_at` datetime(6) NOT NULL,
  `host` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `counter` int NOT NULL DEFAULT '0',
  `raw` json DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `metrics_2019` (`id` bigint NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB;
