-- Joinery structure sync
-- Source: mariadb defaults_comments_dev
-- Target: mariadb defaults_comments_prod
-- Operations: 18
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter column d.s
ALTER TABLE `d` MODIFY COLUMN `s` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'it''s a \\ test';

-- Alter column d.e
ALTER TABLE `d` MODIFY COLUMN `e` enum('a','b''c','d') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'b''c';

-- Alter column d.st
ALTER TABLE `d` MODIFY COLUMN `st` set('x','y') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'x,y';

-- Alter column d.b
ALTER TABLE `d` MODIFY COLUMN `b` bit(3) DEFAULT b'101';

-- Alter column d.f
ALTER TABLE `d` MODIFY COLUMN `f` float DEFAULT 1.5;

-- Alter column d.dt
ALTER TABLE `d` MODIFY COLUMN `dt` datetime(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

-- Alter column d.ts
ALTER TABLE `d` MODIFY COLUMN `ts` timestamp NULL;

-- Alter column d.u
ALTER TABLE `d` MODIFY COLUMN `u` varchar(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT (uuid());

-- Alter column d.n
ALTER TABLE `d` MODIFY COLUMN `n` decimal(10,3) DEFAULT -0.500;

-- Alter column d.bin
ALTER TABLE `d` MODIFY COLUMN `bin` varbinary(4) DEFAULT 0x0A0B;

-- Alter column d.txt
ALTER TABLE `d` MODIFY COLUMN `txt` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'abc';

-- Alter column d.c
ALTER TABLE `d` MODIFY COLUMN `c` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'ëmoji and ''quote'' \\ back';

-- Alter column d.y
ALTER TABLE `d` MODIFY COLUMN `y` year(4) DEFAULT 2024;

-- Alter column d.dd
ALTER TABLE `d` MODIFY COLUMN `dd` date DEFAULT '2024-02-29';

-- Alter column d.expr
ALTER TABLE `d` MODIFY COLUMN `expr` int(11) DEFAULT (1 + 2);

-- Create index d.k_s
ALTER TABLE `d` ADD KEY `k_s` (`s`(10)) COMMENT 'prefix ''idx''';

-- Create index d.uq
ALTER TABLE `d` ADD UNIQUE KEY `uq` (`c`, `y`);

-- Alter table d
ALTER TABLE `d` COMMENT='table ''comment'' ü';

SET FOREIGN_KEY_CHECKS = 1;
