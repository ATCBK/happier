-- Retain the existing short domain key while keeping exact Run source fields.
ALTER TABLE `SessionFollowEdge`
    ADD COLUMN `sourceExecutionRunSessionId` VARCHAR(191) NULL,
    ADD COLUMN `sourceExecutionRunId` VARCHAR(191) NULL,
    ADD COLUMN `sourceWorkflowRunId` VARCHAR(191) NULL,
    ADD COLUMN `deliveredExecutionRunTerminalEventId` VARCHAR(191) NULL,
    ADD COLUMN `deliveredWorkflowRunRevision` INTEGER NULL,
    ADD INDEX `SessionFollowEdge_executionRunSource_idx` (`sourceExecutionRunSessionId`, `sourceExecutionRunId`),
    ADD INDEX `SessionFollowEdge_sourceWorkflowRunId_idx` (`sourceWorkflowRunId`),
    ADD CONSTRAINT `SessionFollowEdge_sourceExecutionRunSessionId_fkey` FOREIGN KEY (`sourceExecutionRunSessionId`) REFERENCES `Session` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `SessionFollowEdge_sourceWorkflowRunId_fkey` FOREIGN KEY (`sourceWorkflowRunId`) REFERENCES `AutomationRun` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
DROP TRIGGER `SessionFollowEdge_source_identity_insert`;
DROP TRIGGER `SessionFollowEdge_source_identity_update`;
CREATE TRIGGER `SessionFollowEdge_source_identity_insert`
BEFORE INSERT ON `SessionFollowEdge`
FOR EACH ROW
BEGIN
    IF NOT (
        (NEW.`sourceSessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sourceSessionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NOT NULL AND NEW.`sourceExecutionRunId` IS NOT NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY LEFT(NEW.`sourceKey`, 14) = BINARY 'execution_run:' AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NOT NULL
            AND BINARY LEFT(NEW.`sourceKey`, 13) = BINARY 'workflow_run:' AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL)
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge source identity mismatch'; END IF;
    IF NOT ((NEW.`relation` = 'manager' AND NEW.`sourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` = NEW.`sourceSessionId`)
        OR (NEW.`relation` = 'follower' AND NEW.`managerSourceSessionId` IS NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge manager relation identity mismatch';
    END IF;
    IF NEW.`deliveredWorkflowRunRevision` IS NOT NULL AND NEW.`deliveredWorkflowRunRevision` < 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge workflow progress invalid';
    END IF;
END;
CREATE TRIGGER `SessionFollowEdge_source_identity_update`
BEFORE UPDATE ON `SessionFollowEdge`
FOR EACH ROW
BEGIN
    IF NOT (
        (NEW.`sourceSessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sourceSessionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NOT NULL AND NEW.`sourceExecutionRunId` IS NOT NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND BINARY LEFT(NEW.`sourceKey`, 14) = BINARY 'execution_run:' AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sourceSessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NOT NULL
            AND BINARY LEFT(NEW.`sourceKey`, 13) = BINARY 'workflow_run:' AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL)
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge source identity mismatch'; END IF;
    IF NOT ((NEW.`relation` = 'manager' AND NEW.`sourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` IS NOT NULL AND NEW.`managerSourceSessionId` = NEW.`sourceSessionId`)
        OR (NEW.`relation` = 'follower' AND NEW.`managerSourceSessionId` IS NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge manager relation identity mismatch';
    END IF;
    IF NEW.`deliveredWorkflowRunRevision` IS NOT NULL AND NEW.`deliveredWorkflowRunRevision` < 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge workflow progress invalid';
    END IF;
END;
