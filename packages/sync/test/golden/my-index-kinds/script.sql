-- Joinery structure sync
-- Source: mariadb index_kinds_dev
-- Target: mariadb index_kinds_prod
-- Operations: 6
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter index i.k_ab
ALTER TABLE `i` DROP INDEX `k_ab`;

-- Alter index i.k_d
ALTER TABLE `i` DROP INDEX `k_d`;

-- Alter index i.uq_b
ALTER TABLE `i` DROP INDEX `uq_b`;

-- Alter index m.k_hash
ALTER TABLE `m` DROP INDEX `k_hash`;

-- Alter index i.k_ab (continued)
ALTER TABLE `i` ADD KEY `k_ab` (`a`(20), `b` DESC);

-- Alter index i.k_d (continued)
ALTER TABLE `i` ADD KEY `k_d` (`d`) COMMENT 'dates';

-- Alter index i.uq_b (continued)
ALTER TABLE `i` ADD UNIQUE KEY `uq_b` (`b`);

-- Create index i.ft_c
ALTER TABLE `i` ADD FULLTEXT KEY `ft_c` (`c`);

-- Create index i.sp_g
ALTER TABLE `i` ADD SPATIAL KEY `sp_g` (`g`);

-- Alter index m.k_hash (continued)
ALTER TABLE `m` ADD KEY `k_hash` (`v`) USING HASH;

SET FOREIGN_KEY_CHECKS = 1;
