ALTER TABLE `Account`
ADD COLUMN `usernameAutoFillEnabled` BOOLEAN NOT NULL DEFAULT true;

UPDATE `Account`
SET `usernameAutoFillEnabled` = false
WHERE `username` IS NOT NULL;

CREATE TABLE `ReleasedUsername` (
    `username` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`username`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
