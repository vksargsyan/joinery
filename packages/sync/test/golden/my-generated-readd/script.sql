-- Joinery structure sync
-- Source: mariadb generated_readd_dev
-- Target: mariadb generated_readd_prod
-- Operations: 8 (2 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter index g.k_multi
-- Re-created because g.s is re-added
ALTER TABLE `g` DROP INDEX `k_multi`;

-- Alter index g.k_s
-- Re-created because g.s is re-added
ALTER TABLE `g` DROP INDEX `k_s`;

-- Alter index g.k_w [not selected by default]
-- Re-created because g.w is re-added
ALTER TABLE `g` DROP INDEX `k_w`;

-- Alter check g.s_pos
-- Re-created because g.s is re-added
ALTER TABLE `g` DROP CONSTRAINT `s_pos`;

-- Alter check g.w_chk [not selected by default]
-- Re-created because g.w is re-added
ALTER TABLE `g` DROP CONSTRAINT `w_chk`;

-- Alter column g.s
--   info: The column is dropped and re-added; indexes and checks on it are re-created after it
ALTER TABLE `g` DROP COLUMN `s`;
ALTER TABLE `g` ADD COLUMN `s` int(11) GENERATED ALWAYS AS (`a` * `b`) STORED AFTER `b`;

-- Alter column g.w [destructive, not selected by default]
--   info: The column is dropped and re-added; indexes and checks on it are re-created after it
--   data-loss: Stored values are replaced by the generation expression
ALTER TABLE `g` DROP COLUMN `w`;
ALTER TABLE `g` ADD COLUMN `w` int(11) GENERATED ALWAYS AS (`a` - `b`) VIRTUAL AFTER `s`;

-- Alter column g.p [destructive, not selected by default]
--   info: The column is dropped and re-added; indexes and checks on it are re-created after it
--   data-loss: The computed values are not kept: the column starts out with its default
ALTER TABLE `g` DROP COLUMN `p`;
ALTER TABLE `g` ADD COLUMN `p` int(11) AFTER `w`;

-- Alter index g.k_multi (continued)
ALTER TABLE `g` ADD KEY `k_multi` (`a`, `s`);

-- Alter index g.k_s (continued)
ALTER TABLE `g` ADD KEY `k_s` (`s`);

-- Alter index g.k_w [not selected by default] (continued)
ALTER TABLE `g` ADD KEY `k_w` (`w`, `a`);

-- Alter check g.s_pos (continued)
ALTER TABLE `g` ADD CONSTRAINT `s_pos` CHECK (`s` >= -100);

-- Alter check g.w_chk [not selected by default] (continued)
ALTER TABLE `g` ADD CONSTRAINT `w_chk` CHECK (`w` < 1000 and `a` > -5);

SET FOREIGN_KEY_CHECKS = 1;
