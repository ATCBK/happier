-- 191-character resource identity plus the longest domain prefix, discussion:.
ALTER TABLE `SessionFollowEdge` ADD COLUMN `sourceKey` VARCHAR(202) NULL, ADD COLUMN `sourceDiscussionId` VARCHAR(191) NULL;
UPDATE `SessionFollowEdge` SET `sourceKey` = CONCAT('session:', `sourceSessionId`);
ALTER TABLE `SessionFollowEdge`
    DROP PRIMARY KEY,
    MODIFY `sourceSessionId` VARCHAR(191) NULL,
    MODIFY `sourceKey` VARCHAR(202) NOT NULL,
    ADD PRIMARY KEY (`destinationSessionId`, `sourceKey`, `relation`),
    ADD UNIQUE INDEX `SessionFollowEdge_session_source_relation_key` (`destinationSessionId`, `sourceSessionId`, `relation`),
    ADD UNIQUE INDEX `SessionFollowEdge_discussion_source_relation_key` (`destinationSessionId`, `sourceDiscussionId`, `relation`),
    ADD INDEX `SessionFollowEdge_sourceDiscussionId_idx` (`sourceDiscussionId`),
    ADD CONSTRAINT `SessionFollowEdge_sourceDiscussionId_fkey` FOREIGN KEY (`sourceDiscussionId`) REFERENCES `Discussion` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
-- MySQL cannot CHECK cascading FK columns. Extend its existing provider-native enforcement.
DROP TRIGGER `SessionFollowEdge_manager_relation_insert`;
DROP TRIGGER `SessionFollowEdge_manager_relation_update`;
CREATE TRIGGER `SessionFollowEdge_source_identity_insert`
BEFORE INSERT ON `SessionFollowEdge`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`sourceSessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sourceSessionId`))
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`))) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge source identity mismatch';
    END IF;
    IF NOT ((NEW.`relation` = 'manager' AND NEW.`sourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` = NEW.`sourceSessionId`)
        OR (NEW.`relation` = 'follower' AND NEW.`managerSourceSessionId` IS NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge manager relation identity mismatch';
    END IF;
END;
CREATE TRIGGER `SessionFollowEdge_source_identity_update`
BEFORE UPDATE ON `SessionFollowEdge`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`sourceSessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sourceSessionId`))
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`))) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge source identity mismatch';
    END IF;
    IF NOT ((NEW.`relation` = 'manager' AND NEW.`sourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` = NEW.`sourceSessionId`)
        OR (NEW.`relation` = 'follower' AND NEW.`managerSourceSessionId` IS NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge manager relation identity mismatch';
    END IF;
END;
INSERT INTO `SessionFollowEdge` (`sourceKey`, `sourceDiscussionId`, `destinationSessionId`, `mode`, `deliveredTranscriptSeq`)
SELECT CONCAT('discussion:', d.`id`), d.`id`, p.`sessionId`, 'wake_on_human_change', d.`messageSeq`
FROM `DiscussionParticipant` p JOIN `Discussion` d ON d.`id` = p.`discussionId`
WHERE p.`sessionId` IS NOT NULL AND p.`removedAt` IS NULL;
