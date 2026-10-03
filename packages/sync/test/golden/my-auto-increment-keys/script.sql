-- Querybara structure sync
-- Source: mariadb auto_increment_keys_dev
-- Target: mariadb auto_increment_keys_prod
-- Operations: 6
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter column c.id
ALTER TABLE `c` MODIFY COLUMN `id` int(11) NOT NULL;

-- Alter column d.n
ALTER TABLE `d` MODIFY COLUMN `n` int(11) NOT NULL;

-- Drop index d.k_n
ALTER TABLE `d` DROP INDEX `k_n`;

-- Create index b.k_n
ALTER TABLE `b` ADD KEY `k_n` (`n`);

-- Alter column a.id
ALTER TABLE `a` MODIFY COLUMN `id` int(11) NOT NULL AUTO_INCREMENT;

-- Alter column b.n
ALTER TABLE `b` MODIFY COLUMN `n` int(11) NOT NULL AUTO_INCREMENT;

SET FOREIGN_KEY_CHECKS = 1;
