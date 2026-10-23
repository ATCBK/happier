BEGIN;
ALTER TABLE "AccountSessionFollow"
    DROP CONSTRAINT "AccountSessionFollow_source_identity_check",
    ADD CONSTRAINT "AccountSessionFollow_source_identity_check" CHECK (
        ("sessionId" IS NOT NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND ("sourceKey" IS NULL OR "sourceKey" = 'session:' || "sessionId")
            AND "deliveredDiscussionSeq" IS NULL AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sessionId" IS NULL AND "sourceDiscussionId" IS NOT NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" IS NOT NULL AND "sourceKey" = 'discussion:' || "sourceDiscussionId"
            AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sessionId" IS NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NOT NULL AND "sourceExecutionRunId" IS NOT NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" IS NOT NULL AND substr("sourceKey", 1, 14) = 'execution_run:'
            AND "deliveredDiscussionSeq" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sessionId" IS NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NOT NULL
            AND "sourceKey" IS NOT NULL AND substr("sourceKey", 1, 13) = 'workflow_run:'
            AND "deliveredDiscussionSeq" IS NULL AND "deliveredExecutionRunTerminalEventId" IS NULL)
    );
COMMIT;
