-- MariaDB 11.4
CREATE SEQUENCE `device_seq` START WITH 1 INCREMENT BY 1;
CREATE TABLE `devices` (
  `id` uuid NOT NULL,
  `serial` bigint(20) unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `meta` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`meta`)),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
