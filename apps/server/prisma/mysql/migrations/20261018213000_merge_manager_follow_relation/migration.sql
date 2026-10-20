-- Nullable unique manager source is portable across PostgreSQL, SQLite and MySQL.
ALTER TABLE `SessionFollowEdge`
    ADD COLUMN `relation` VARCHAR(191) NOT NULL DEFAULT 'follower',
    ADD COLUMN `attachedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `managerSourceSessionId` VARCHAR(191) NULL,
    DROP PRIMARY KEY,
    DROP CHECK `SessionFollowEdge_deliveredTurn_pair_check`,
    ADD PRIMARY KEY (`destinationSessionId`, `sourceSessionId`, `relation`),
    ADD CONSTRAINT `SessionFollowEdge_deliveredTurn_pair_check` CHECK (`deliveredTurnStatus` IS NULL OR `deliveredTurnId` IS NOT NULL),
    ADD UNIQUE INDEX `SessionFollowEdge_managerSourceSessionId_key` (`managerSourceSessionId`);
-- MySQL forbids a CHECK over sourceSessionId because it has a cascading FK.
CREATE TRIGGER `SessionFollowEdge_manager_relation_insert`
BEFORE INSERT ON `SessionFollowEdge`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`relation` = 'manager' AND NEW.`managerSourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` = NEW.`sourceSessionId`)
        OR (NEW.`relation` = 'follower' AND NEW.`managerSourceSessionId` IS NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge manager relation identity mismatch';
    END IF;
END;
CREATE TRIGGER `SessionFollowEdge_manager_relation_update`
BEFORE UPDATE ON `SessionFollowEdge`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`relation` = 'manager' AND NEW.`managerSourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` = NEW.`sourceSessionId`)
        OR (NEW.`relation` = 'follower' AND NEW.`managerSourceSessionId` IS NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge manager relation identity mismatch';
    END IF;
END;
INSERT INTO `SessionFollowEdge` (`sourceSessionId`, `destinationSessionId`, `relation`, `attachedAt`, `managerSourceSessionId`, `deliveredTranscriptSeq`, `deliveredReadyEventSeq`, `deliveredAgentStateVersion`, `deliveredTurnId`, `deliveredTurnStatus`)
SELECT `sessionId`, `leadSessionId`, 'manager', `attachedAt`, `sessionId`, `deliveredTranscriptSeq`, `deliveredReadyEventSeq`, `deliveredAgentStateVersion`, `deliveredTurnId`, `deliveredTurnStatus` FROM `SessionReportsTo`;
DROP TABLE `SessionReportsTo`;
