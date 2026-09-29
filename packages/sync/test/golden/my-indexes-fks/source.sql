CREATE TABLE `authors` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) NOT NULL,
  `country` char(2) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_authors_email` (`email`),
  KEY `idx_country` (`country`,`id`) COMMENT 'by country'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `books` (
  `id` int NOT NULL AUTO_INCREMENT,
  `author_id` int NOT NULL,
  `isbn` varchar(20) NOT NULL,
  `title` varchar(200) NOT NULL,
  `published` date DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_books_isbn` (`isbn`),
  KEY `fk_books_author` (`author_id`,`published`),
  KEY `idx_books_title` (`title`) /*!80000 INVISIBLE */,
  CONSTRAINT `fk_books_author` FOREIGN KEY (`author_id`) REFERENCES `authors` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `reviews` (
  `id` int NOT NULL,
  `book_id` int NOT NULL,
  `stars` tinyint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `book_id` (`book_id`),
  CONSTRAINT `reviews_ibfk_1` FOREIGN KEY (`book_id`) REFERENCES `books` (`id`) ON DELETE CASCADE,
  CONSTRAINT `reviews_stars_chk` CHECK ((`stars` between 1 and 5))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
