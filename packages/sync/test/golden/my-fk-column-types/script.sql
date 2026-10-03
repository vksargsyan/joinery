-- Querybara structure sync
-- Source: mariadb fk_column_types_dev
-- Target: mariadb fk_column_types_prod
-- Operations: 6
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter foreign key child.fk_parent
-- Rebuilt because child.parent_id changes type
ALTER TABLE `child` DROP FOREIGN KEY `fk_parent`;

-- Alter foreign key child.fk_code
-- Rebuilt because child.parent_code changes type
ALTER TABLE `child` DROP FOREIGN KEY `fk_code`;

-- Alter column child.parent_id
ALTER TABLE `child` MODIFY COLUMN `parent_id` bigint(20);

-- Alter column child.parent_code
ALTER TABLE `child` MODIFY COLUMN `parent_code` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

-- Alter column parent.id
ALTER TABLE `parent` MODIFY COLUMN `id` bigint(20) NOT NULL;

-- Alter column parent.code
ALTER TABLE `parent` MODIFY COLUMN `code` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

-- Alter foreign key child.fk_parent (continued)
ALTER TABLE `child` ADD CONSTRAINT `fk_parent` FOREIGN KEY (`parent_id`) REFERENCES `parent` (`id`) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Alter foreign key child.fk_code (continued)
ALTER TABLE `child` ADD CONSTRAINT `fk_code` FOREIGN KEY (`parent_code`) REFERENCES `parent` (`code`) ON UPDATE RESTRICT ON DELETE RESTRICT;

SET FOREIGN_KEY_CHECKS = 1;
