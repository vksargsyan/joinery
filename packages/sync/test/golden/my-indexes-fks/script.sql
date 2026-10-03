-- Querybara structure sync
-- Source: mysql shop_dev
-- Target: mysql shop_prod
-- Operations: 8
-- Warning: MySQL DDL is not transactional: a failure part-way leaves the target partly changed. Back up the target first.

SET FOREIGN_KEY_CHECKS = 0;

-- Alter foreign key reviews.reviews_ibfk_1
ALTER TABLE `reviews` DROP FOREIGN KEY `reviews_ibfk_1`;

-- Alter index authors.idx_country
ALTER TABLE `authors` DROP INDEX `idx_country`;

-- Drop index books.idx_old_pub
ALTER TABLE `books` DROP INDEX `idx_old_pub`;

-- Rename index authors.uq_authors_email
ALTER TABLE `authors` RENAME INDEX `email` TO `uq_authors_email`;

-- Alter index authors.idx_country (continued)
ALTER TABLE `authors` ADD KEY `idx_country` (`country`, `id`) COMMENT 'by country';

-- Alter index books.fk_books_author
ALTER TABLE `books` DROP INDEX `fk_books_author`, ADD KEY `fk_books_author` (`author_id`, `published`);

-- Create index books.uq_books_isbn
ALTER TABLE `books` ADD UNIQUE KEY `uq_books_isbn` (`isbn`);

-- Create check reviews.reviews_stars_chk
--   may-fail: Adding the check fails if existing rows violate it
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_stars_chk` CHECK (`stars` between 1 and 5);

-- Alter index books.idx_books_title
ALTER TABLE `books` ALTER INDEX `idx_books_title` INVISIBLE;

-- Alter foreign key reviews.reviews_ibfk_1 (continued)
ALTER TABLE `reviews` ADD CONSTRAINT `reviews_ibfk_1` FOREIGN KEY (`book_id`) REFERENCES `books` (`id`) ON DELETE CASCADE;

SET FOREIGN_KEY_CHECKS = 1;
