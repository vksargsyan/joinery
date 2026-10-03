-- Querybara structure sync
-- Source: mariadb fks_composite_dev
-- Target: mariadb fks_composite_prod
-- Operations: 12 (1 destructive)
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter foreign key c.fk_p
ALTER TABLE `c` DROP FOREIGN KEY `fk_p`;

-- Drop table old_child [destructive, not selected by default]
--   data-loss: Drops table old_child and all of its rows
DROP TABLE `old_child`;

-- Alter index c.k_pab
ALTER TABLE `c` DROP INDEX `k_pab`;

-- Create column p.b
--   may-fail: Adding a NOT NULL column without a default fails when the table has rows
ALTER TABLE `p` ADD COLUMN `b` int(11) NOT NULL AFTER `a`;

-- Alter index c.k_pab (continued)
ALTER TABLE `c` ADD KEY `k_pab` (`pa`, `pb`);

-- Create index c.fk_name
ALTER TABLE `c` ADD KEY `fk_name` (`pname`);

-- Create index c.k_self
ALTER TABLE `c` ADD KEY `k_self` (`self_id`);

-- Alter primary key p.PRIMARY
ALTER TABLE `p` DROP PRIMARY KEY, ADD PRIMARY KEY (`a`, `b`);

-- Create index p.uq_name
ALTER TABLE `p` ADD UNIQUE KEY `uq_name` (`name`);

-- Create table newbie
CREATE TABLE `newbie` (
  `id` int(11) NOT NULL,
  `c_id` int(11),
  PRIMARY KEY (`id`),
  KEY `fk_new` (`c_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Alter foreign key c.fk_p (continued)
ALTER TABLE `c` ADD CONSTRAINT `fk_p` FOREIGN KEY (`pa`, `pb`) REFERENCES `p` (`a`, `b`) ON UPDATE CASCADE ON DELETE SET NULL;

-- Create foreign key c.fk_name
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE `c` ADD CONSTRAINT `fk_name` FOREIGN KEY (`pname`) REFERENCES `p` (`name`) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Create foreign key c.fk_self
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE `c` ADD CONSTRAINT `fk_self` FOREIGN KEY (`self_id`) REFERENCES `c` (`id`) ON UPDATE RESTRICT ON DELETE CASCADE;

-- Create foreign key newbie.fk_new
--   may-fail: Adding the foreign key fails if existing rows have no matching parent
ALTER TABLE `newbie` ADD CONSTRAINT `fk_new` FOREIGN KEY (`c_id`) REFERENCES `c` (`id`) ON UPDATE RESTRICT ON DELETE RESTRICT;

SET FOREIGN_KEY_CHECKS = 1;
