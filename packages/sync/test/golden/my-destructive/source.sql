CREATE TABLE `metrics` (
  `id` bigint NOT NULL,
  `kind` enum('cpu','mem','gpu') NOT NULL,
  `value` float NOT NULL,
  `sampled_at` datetime NOT NULL,
  `host` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `counter` smallint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
