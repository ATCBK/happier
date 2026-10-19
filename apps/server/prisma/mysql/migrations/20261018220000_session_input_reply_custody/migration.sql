ALTER TABLE `SessionPendingMessage` ADD COLUMN `replyProgress` JSON NULL,
    ADD COLUMN `replySourceSessionId` VARCHAR(191) NULL,
    ADD COLUMN `replySourceTurnId` VARCHAR(191) NULL,
    ADD COLUMN `replyDisposition` VARCHAR(191) NULL;
ALTER TABLE `SessionMessage` ADD COLUMN `replyProgress` JSON NULL,
    ADD COLUMN `replySourceSessionId` VARCHAR(191) NULL,
    ADD COLUMN `replySourceTurnId` VARCHAR(191) NULL,
    ADD COLUMN `replyDisposition` VARCHAR(191) NULL;
CREATE INDEX `SessionPendingMessage_reply_source_idx` ON `SessionPendingMessage`(`replySourceSessionId`, `replySourceTurnId`);
CREATE INDEX `SessionMessage_reply_source_idx` ON `SessionMessage`(`replySourceSessionId`, `replySourceTurnId`);
CREATE INDEX `SessionPendingMessage_reply_disposition_idx` ON `SessionPendingMessage`(`sessionId`, `replyDisposition`, `localId`);
CREATE INDEX `SessionMessage_reply_disposition_idx` ON `SessionMessage`(`sessionId`, `replyDisposition`, `localId`);
