CREATE TABLE `DiscussionAttachment` (
    `blobId` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(191) NOT NULL,
    `storageKey` VARCHAR(191) NOT NULL,
    `encryptionMode` VARCHAR(191) NOT NULL,
    `storedSizeBytes` BIGINT NOT NULL,
    UNIQUE INDEX `DiscussionAttachment_storageKey_key`(`storageKey`),
    INDEX `DiscussionAttachment_messageId_idx`(`messageId`),
    PRIMARY KEY (`blobId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `DiscussionAttachment` ADD CONSTRAINT `DiscussionAttachment_messageId_fkey`
    FOREIGN KEY (`messageId`) REFERENCES `DiscussionMessage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
