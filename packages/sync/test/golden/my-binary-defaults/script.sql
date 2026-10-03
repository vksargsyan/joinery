-- Querybara structure sync
-- Source: mariadb binary_defaults_dev
-- Target: mariadb binary_defaults_prod
-- Operations: 3
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter column b.v
ALTER TABLE `b` MODIFY COLUMN `v` varbinary(4) DEFAULT 0x00FF41;

-- Alter column b.w
ALTER TABLE `b` MODIFY COLUMN `w` binary(2) DEFAULT 0xC3A9;

-- Alter column b.y
ALTER TABLE `b` MODIFY COLUMN `y` varbinary(8) DEFAULT 0x6127625C63;

SET FOREIGN_KEY_CHECKS = 1;
