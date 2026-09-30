-- Joinery structure sync
-- Source: mariadb helpdesk_dev
-- Target: mariadb helpdesk
-- Operations: 7 (1 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Create sequence invoice_seq
CREATE SEQUENCE `invoice_seq` INCREMENT BY 1 MINVALUE 1 MAXVALUE 99999999 START WITH 5000 CACHE 1000 CYCLE;

-- Create column tickets.closed_at
ALTER TABLE `tickets` ADD COLUMN `closed_at` datetime AFTER `opened_at`;

-- Alter index tickets.idx_subject
ALTER TABLE `tickets` ALTER INDEX `idx_subject` IGNORED;

-- Alter sequence ticket_seq
ALTER SEQUENCE `ticket_seq` INCREMENT BY 10 CACHE 100;

-- Alter column tickets.id
ALTER TABLE `tickets` MODIFY COLUMN `id` bigint(20) NOT NULL DEFAULT (nextval(`ticket_seq`));

-- Alter column tickets.subject
ALTER TABLE `tickets` MODIFY COLUMN `subject` varchar(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

-- Drop sequence old_seq [destructive, not selected by default]
--   data-loss: Drops sequence old_seq and its current value
DROP SEQUENCE IF EXISTS `old_seq`;

SET FOREIGN_KEY_CHECKS = 1;
