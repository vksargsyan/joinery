-- Querybara structure sync
-- Source: mysql links_dev
-- Target: mysql links_prod
-- Operations: 3
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Create column tags.id
ALTER TABLE `tags` ADD COLUMN `id` int unsigned NOT NULL AUTO_INCREMENT FIRST, ADD PRIMARY KEY (`id`);

-- Alter primary key links.PRIMARY
ALTER TABLE `links` DROP PRIMARY KEY, ADD PRIMARY KEY (`a`, `b`);

-- Create index tags.uq_tags_name
ALTER TABLE `tags` ADD UNIQUE KEY `uq_tags_name` (`name`);

SET FOREIGN_KEY_CHECKS = 1;
