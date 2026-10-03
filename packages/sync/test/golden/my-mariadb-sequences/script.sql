-- Querybara structure sync
-- Source: mariadb mariadb_sequences_dev
-- Target: mariadb mariadb_sequences_prod
-- Operations: 5
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter sequence s1
--   info: A current value outside the new range is moved to its nearest end
SELECT SETVAL(`s1`, 5, 0) FROM `s1` WHERE next_not_cached_value < 5;
ALTER SEQUENCE `s1` INCREMENT BY 5 MINVALUE 5 START WITH 10;

-- Alter column t.id
ALTER TABLE `t` MODIFY COLUMN `id` bigint(20) NOT NULL DEFAULT (nextval(`s1`));

-- Alter sequence s2
--   info: The new range excludes every current value: the sequence restarts at START
ALTER SEQUENCE `s2` MINVALUE 200 MAXVALUE 300 START WITH 250 RESTART;

-- Alter sequence s3
--   may-fail: A current value past the new MAXVALUE leaves the sequence run out
ALTER SEQUENCE `s3` MAXVALUE 2;

-- Alter sequence s4
ALTER SEQUENCE `s4` MINVALUE -1000 MAXVALUE -1 START WITH -1;

SET FOREIGN_KEY_CHECKS = 1;
