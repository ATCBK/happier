ALTER TABLE `PublicSessionShare` MODIFY `sessionId` VARCHAR(191) NULL;
ALTER TABLE `PublicSessionShare` ADD COLUMN `artifactId` VARCHAR(191) NULL;
ALTER TABLE `PublicSessionShare` ADD COLUMN `keyDerivation` VARCHAR(191) NOT NULL DEFAULT 'legacy_token_v1';
ALTER TABLE `PublicSessionShare` ADD CONSTRAINT `PublicSessionShare_keyDerivation_check` CHECK (`keyDerivation` IN ('legacy_token_v1', 'fragment_v1'));
CREATE UNIQUE INDEX `PublicSessionShare_artifactId_key` ON `PublicSessionShare`(`artifactId`);
ALTER TABLE `PublicSessionShare` ADD CONSTRAINT `PublicSessionShare_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `Artifact`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- MySQL rejects a CHECK over sessionId/artifactId because both participate in
-- cascading foreign keys (error 3823). Preserve the provider-independent
-- exactly-one-subject invariant with an explicit provider error.
CREATE TRIGGER `PublicSessionShare_subject_insert`
BEFORE INSERT ON `PublicSessionShare`
FOR EACH ROW
BEGIN
    IF (NEW.`sessionId` IS NOT NULL) = (NEW.`artifactId` IS NOT NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PublicSessionShare must reference exactly one of sessionId or artifactId';
    END IF;
END;

CREATE TRIGGER `PublicSessionShare_subject_update`
BEFORE UPDATE ON `PublicSessionShare`
FOR EACH ROW
BEGIN
    IF (NEW.`sessionId` IS NOT NULL) = (NEW.`artifactId` IS NOT NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PublicSessionShare must reference exactly one of sessionId or artifactId';
    END IF;
END;
