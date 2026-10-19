ALTER TABLE `Artifact` ADD COLUMN `kind` VARCHAR(191) NULL;
CREATE INDEX `Artifact_accountId_kind_idx` ON `Artifact`(`accountId`, `kind`);
