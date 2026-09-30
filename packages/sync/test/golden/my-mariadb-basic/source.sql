-- MariaDB 10.11
CREATE SEQUENCE `ticket_seq` START WITH 1 INCREMENT BY 10 CACHE 100;
CREATE SEQUENCE `invoice_seq` START WITH 5000 INCREMENT BY 1 MAXVALUE 99999999 CYCLE;
CREATE TABLE `tickets` (
  `id` bigint(20) NOT NULL DEFAULT nextval(`ticket_seq`),
  `subject` varchar(250) NOT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `opened_at` datetime NOT NULL DEFAULT current_timestamp(),
  `closed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_subject` (`subject`) IGNORED
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
