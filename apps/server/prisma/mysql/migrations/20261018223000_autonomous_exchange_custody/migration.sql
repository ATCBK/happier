ALTER TABLE `SessionPendingMessage` ADD COLUMN `autonomousExchangeRootSessionId` VARCHAR(191) NULL,
    ADD COLUMN `autonomousExchangeRootLocalId` VARCHAR(191) NULL,
    ADD COLUMN `autonomousExchangeState` JSON NULL;
ALTER TABLE `SessionPendingMessage` ADD COLUMN `autonomousExchangeCause` VARCHAR(191) NULL;
ALTER TABLE `SessionPendingMessage` ADD COLUMN `turnStartWitnessId` VARCHAR(191) NULL;
ALTER TABLE `SessionMessage` ADD COLUMN `autonomousExchangeRootSessionId` VARCHAR(191) NULL,
    ADD COLUMN `autonomousExchangeRootLocalId` VARCHAR(191) NULL,
    ADD COLUMN `autonomousExchangeState` JSON NULL,
    ADD COLUMN `autonomousExchangeCause` VARCHAR(191) NULL,
    ADD COLUMN `acceptedTurnKind` VARCHAR(191) NULL,
    ADD COLUMN `acceptedTurnId` VARCHAR(191) NULL,
    ADD COLUMN `turnStartWitnessId` VARCHAR(191) NULL,
    ADD COLUMN `acceptedTurnCounted` BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX `SessionPendingMessage_exchange_root_idx` ON `SessionPendingMessage`(`autonomousExchangeRootSessionId`, `autonomousExchangeRootLocalId`, `status`);
CREATE INDEX `SessionMessage_exchange_root_idx` ON `SessionMessage`(`autonomousExchangeRootSessionId`, `autonomousExchangeRootLocalId`);
CREATE INDEX `SessionMessage_accepted_turn_idx` ON `SessionMessage`(`sessionId`, `acceptedTurnId`);
