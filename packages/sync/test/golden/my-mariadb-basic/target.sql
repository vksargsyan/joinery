-- MariaDB 10.11
CREATE SEQUENCE `ticket_seq` START WITH 1 INCREMENT BY 1 CACHE 1000;
CREATE SEQUENCE `old_seq`;
CREATE TABLE `tickets` (
  `id` bigint(20) NOT NULL,
  `subject` varchar(200) NOT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `opened_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_subject` (`subject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
