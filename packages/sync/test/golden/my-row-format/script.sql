-- Joinery structure sync
-- Source: mariadb row_format_dev
-- Target: mariadb row_format_prod
-- Operations: 2
-- Warning: MariaDB DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter table declared_compact
ALTER TABLE `declared_compact` ROW_FORMAT=COMPACT;

-- Alter table declared_default
ALTER TABLE `declared_default` ROW_FORMAT=DEFAULT;

SET FOREIGN_KEY_CHECKS = 1;
