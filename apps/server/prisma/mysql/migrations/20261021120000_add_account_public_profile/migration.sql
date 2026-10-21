CREATE TABLE `AccountPublicProfile` (
    `accountId` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `policyJson` LONGTEXT NULL,
    `metadataJson` LONGTEXT NULL,
    `queryJson` LONGTEXT NULL,
    `snapshotJson` LONGTEXT NULL,
    `layoutJson` LONGTEXT NULL,
    `appearanceJson` LONGTEXT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `publishedAt` DATETIME(3) NULL,
    `removedAt` DATETIME(3) NULL,
    `removedByAccountId` VARCHAR(191) NULL,
    `removalReason` LONGTEXT NULL,
    PRIMARY KEY (`accountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `AccountPublicProfile` ADD CONSTRAINT `AccountPublicProfile_accountId_fkey`
    FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
