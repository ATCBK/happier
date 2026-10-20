ALTER TABLE `SessionMessage` ADD COLUMN `acceptedFollowOriginalKey` VARCHAR(191) NULL;
CREATE INDEX `SessionMessage_accepted_follow_original_idx` ON `SessionMessage`(`sessionId`, `acceptedFollowOriginalKey`);
