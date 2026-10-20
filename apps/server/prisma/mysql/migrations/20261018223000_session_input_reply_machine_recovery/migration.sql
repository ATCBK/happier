ALTER TABLE `SessionMessage` ADD COLUMN `replyTargetMachineId` VARCHAR(191) NULL;
ALTER TABLE `SessionPendingMessage` ADD COLUMN `replyTargetMachineId` VARCHAR(191) NULL;
UPDATE `SessionMessage` SET `replyTargetMachineId` = JSON_UNQUOTE(JSON_EXTRACT(`inputAdmissionReceipt`, '$.admittedTarget.machineId'))
WHERE `replyProgress` IS NOT NULL AND JSON_UNQUOTE(JSON_EXTRACT(`inputAdmissionReceipt`, '$.issuer')) = 'authenticatedMachine';
UPDATE `SessionPendingMessage` SET `replyTargetMachineId` = JSON_UNQUOTE(JSON_EXTRACT(`inputAdmissionReceipt`, '$.admittedTarget.machineId'))
WHERE `replyProgress` IS NOT NULL AND JSON_UNQUOTE(JSON_EXTRACT(`inputAdmissionReceipt`, '$.issuer')) = 'authenticatedMachine';
CREATE INDEX `SessionMessage_reply_machine_idx` ON `SessionMessage`(`replyTargetMachineId`, `replyDisposition`, `sessionId`, `localId`);
CREATE INDEX `SessionPendingMessage_reply_machine_idx` ON `SessionPendingMessage`(`replyTargetMachineId`, `replyDisposition`, `sessionId`, `localId`);
