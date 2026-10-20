-- Keep the existing personal Follow table and Session lookup while admitting generic sources.
ALTER TABLE `AccountSessionFollow`
    ADD COLUMN `id` VARCHAR(191) NULL,
    ADD COLUMN `sourceKey` VARCHAR(202) NULL,
    ADD COLUMN `sourceDiscussionId` VARCHAR(191) NULL,
    ADD COLUMN `sourceExecutionRunSessionId` VARCHAR(191) NULL,
    ADD COLUMN `sourceExecutionRunId` VARCHAR(191) NULL,
    ADD COLUMN `sourceWorkflowRunId` VARCHAR(191) NULL,
    ADD COLUMN `deliveredDiscussionSeq` INTEGER NULL,
    ADD COLUMN `deliveredExecutionRunTerminalEventId` VARCHAR(191) NULL,
    ADD COLUMN `deliveredWorkflowRunRevision` INTEGER NULL;
UPDATE `AccountSessionFollow` SET `id` = CONCAT('legacy:', UUID()), `sourceKey` = CONCAT('session:', `sessionId`);
ALTER TABLE `AccountSessionFollow`
    DROP PRIMARY KEY,
    MODIFY `id` VARCHAR(191) NOT NULL,
    MODIFY `sessionId` VARCHAR(191) NULL,
    ADD PRIMARY KEY (`id`),
    ADD UNIQUE INDEX `AccountSessionFollow_accountId_sessionId_key` (`accountId`, `sessionId`),
    ADD UNIQUE INDEX `AccountSessionFollow_accountId_sourceKey_key` (`accountId`, `sourceKey`),
    ADD INDEX `AccountSessionFollow_sourceDiscussionId_idx` (`sourceDiscussionId`),
    ADD INDEX `AccountSessionFollow_sourceExecutionRunSessionId_idx` (`sourceExecutionRunSessionId`),
    ADD INDEX `AccountSessionFollow_sourceWorkflowRunId_idx` (`sourceWorkflowRunId`),
    ADD CONSTRAINT `AccountSessionFollow_sourceDiscussionId_fkey` FOREIGN KEY (`sourceDiscussionId`) REFERENCES `Discussion` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `AccountSessionFollow_sourceExecutionRunSessionId_fkey` FOREIGN KEY (`sourceExecutionRunSessionId`) REFERENCES `Session` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `AccountSessionFollow_sourceWorkflowRunId_fkey` FOREIGN KEY (`sourceWorkflowRunId`) REFERENCES `AutomationRun` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
-- Cascading FK columns are validated by provider-native triggers rather than CHECK.
CREATE TRIGGER `AccountSessionFollow_source_identity_insert`
BEFORE INSERT ON `AccountSessionFollow`
FOR EACH ROW
BEGIN
    IF NOT (
        (NEW.`sessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND (NEW.`sourceKey` IS NULL OR BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sessionId`))
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NOT NULL AND NEW.`sourceExecutionRunId` IS NOT NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY LEFT(NEW.`sourceKey`, 14) = BINARY 'execution_run:'
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NOT NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY LEFT(NEW.`sourceKey`, 13) = BINARY 'workflow_run:'
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL)
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AccountSessionFollow source identity mismatch'; END IF;
    IF (NEW.`deliveredDiscussionSeq` IS NOT NULL AND NEW.`deliveredDiscussionSeq` < 0)
        OR (NEW.`deliveredWorkflowRunRevision` IS NOT NULL AND NEW.`deliveredWorkflowRunRevision` < 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AccountSessionFollow source progress invalid';
    END IF;
END;
CREATE TRIGGER `AccountSessionFollow_source_identity_update`
BEFORE UPDATE ON `AccountSessionFollow`
FOR EACH ROW
BEGIN
    IF NOT (
        (NEW.`sessionId` IS NOT NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND (NEW.`sourceKey` IS NULL OR BINARY NEW.`sourceKey` = BINARY CONCAT('session:', NEW.`sessionId`))
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NOT NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY NEW.`sourceKey` = BINARY CONCAT('discussion:', NEW.`sourceDiscussionId`)
            AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NOT NULL AND NEW.`sourceExecutionRunId` IS NOT NULL AND NEW.`sourceWorkflowRunId` IS NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY LEFT(NEW.`sourceKey`, 14) = BINARY 'execution_run:'
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredWorkflowRunRevision` IS NULL)
        OR (NEW.`sessionId` IS NULL AND NEW.`sourceDiscussionId` IS NULL AND NEW.`sourceExecutionRunSessionId` IS NULL AND NEW.`sourceExecutionRunId` IS NULL AND NEW.`sourceWorkflowRunId` IS NOT NULL
            AND NEW.`sourceKey` IS NOT NULL AND BINARY LEFT(NEW.`sourceKey`, 13) = BINARY 'workflow_run:'
            AND NEW.`deliveredDiscussionSeq` IS NULL AND NEW.`deliveredExecutionRunTerminalEventId` IS NULL)
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AccountSessionFollow source identity mismatch'; END IF;
    IF (NEW.`deliveredDiscussionSeq` IS NOT NULL AND NEW.`deliveredDiscussionSeq` < 0)
        OR (NEW.`deliveredWorkflowRunRevision` IS NOT NULL AND NEW.`deliveredWorkflowRunRevision` < 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AccountSessionFollow source progress invalid';
    END IF;
END;
