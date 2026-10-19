-- Keep the existing edge key and all accepted Session/Discussion progress.
ALTER TABLE "SessionFollowEdge"
    ADD COLUMN "sourceExecutionRunSessionId" TEXT,
    ADD COLUMN "sourceExecutionRunId" TEXT,
    ADD COLUMN "sourceWorkflowRunId" TEXT,
    ADD COLUMN "deliveredExecutionRunTerminalEventId" TEXT,
    ADD COLUMN "deliveredWorkflowRunRevision" INTEGER;
ALTER TABLE "SessionFollowEdge"
    DROP CONSTRAINT "SessionFollowEdge_source_identity_check",
    ADD CONSTRAINT "SessionFollowEdge_source_identity_check" CHECK (
        ("sourceSessionId" IS NOT NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" = 'session:' || "sourceSessionId" AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NOT NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" = 'discussion:' || "sourceDiscussionId" AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NOT NULL AND "sourceExecutionRunId" IS NOT NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" LIKE 'execution_run:%' AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NOT NULL
            AND "sourceKey" LIKE 'workflow_run:%' AND "deliveredExecutionRunTerminalEventId" IS NULL)
    ),
    ADD CONSTRAINT "SessionFollowEdge_workflow_progress_check" CHECK ("deliveredWorkflowRunRevision" IS NULL OR "deliveredWorkflowRunRevision" >= 0),
    ADD CONSTRAINT "SessionFollowEdge_sourceExecutionRunSessionId_fkey" FOREIGN KEY ("sourceExecutionRunSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "SessionFollowEdge_sourceWorkflowRunId_fkey" FOREIGN KEY ("sourceWorkflowRunId") REFERENCES "AutomationRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SessionFollowEdge_sourceExecutionRunSessionId_sourceExecutionRunId_idx" ON "SessionFollowEdge" ("sourceExecutionRunSessionId", "sourceExecutionRunId");
CREATE INDEX "SessionFollowEdge_sourceWorkflowRunId_idx" ON "SessionFollowEdge" ("sourceWorkflowRunId");
