-- Preserve personal policies, one-shots and Voice custody while broadening the source.
ALTER TABLE "AccountSessionFollow"
    ADD COLUMN "id" TEXT,
    ADD COLUMN "sourceKey" TEXT,
    ADD COLUMN "sourceDiscussionId" TEXT,
    ADD COLUMN "sourceExecutionRunSessionId" TEXT,
    ADD COLUMN "sourceExecutionRunId" TEXT,
    ADD COLUMN "sourceWorkflowRunId" TEXT,
    ADD COLUMN "deliveredDiscussionSeq" INTEGER,
    ADD COLUMN "deliveredExecutionRunTerminalEventId" TEXT,
    ADD COLUMN "deliveredWorkflowRunRevision" INTEGER;
WITH numbered AS (
    SELECT ctid, row_number() OVER (ORDER BY "accountId", "sessionId") AS n FROM "AccountSessionFollow"
)
UPDATE "AccountSessionFollow" AS follow SET "id" = 'legacy:' || numbered.n, "sourceKey" = 'session:' || follow."sessionId"
FROM numbered WHERE follow.ctid = numbered.ctid;
ALTER TABLE "AccountSessionFollow"
    DROP CONSTRAINT "AccountSessionFollow_pkey",
    ALTER COLUMN "sessionId" DROP NOT NULL,
    ALTER COLUMN "id" SET NOT NULL,
    ADD CONSTRAINT "AccountSessionFollow_pkey" PRIMARY KEY ("id"),
    ADD CONSTRAINT "AccountSessionFollow_source_identity_check" CHECK (
        ("sessionId" IS NOT NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND ("sourceKey" IS NULL OR "sourceKey" = 'session:' || "sessionId")
            AND "deliveredDiscussionSeq" IS NULL AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sessionId" IS NULL AND "sourceDiscussionId" IS NOT NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" = 'discussion:' || "sourceDiscussionId"
            AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sessionId" IS NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NOT NULL AND "sourceExecutionRunId" IS NOT NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" LIKE 'execution_run:%' AND "deliveredDiscussionSeq" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sessionId" IS NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NOT NULL
            AND "sourceKey" LIKE 'workflow_run:%' AND "deliveredDiscussionSeq" IS NULL AND "deliveredExecutionRunTerminalEventId" IS NULL)
    ),
    ADD CONSTRAINT "AccountSessionFollow_source_progress_check" CHECK (("deliveredDiscussionSeq" IS NULL OR "deliveredDiscussionSeq" >= 0)
        AND ("deliveredWorkflowRunRevision" IS NULL OR "deliveredWorkflowRunRevision" >= 0)),
    ADD CONSTRAINT "AccountSessionFollow_sourceDiscussionId_fkey" FOREIGN KEY ("sourceDiscussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AccountSessionFollow_sourceExecutionRunSessionId_fkey" FOREIGN KEY ("sourceExecutionRunSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AccountSessionFollow_sourceWorkflowRunId_fkey" FOREIGN KEY ("sourceWorkflowRunId") REFERENCES "AutomationRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "AccountSessionFollow_accountId_sessionId_key" ON "AccountSessionFollow" ("accountId", "sessionId");
CREATE UNIQUE INDEX "AccountSessionFollow_accountId_sourceKey_key" ON "AccountSessionFollow" ("accountId", "sourceKey");
CREATE INDEX "AccountSessionFollow_sourceDiscussionId_idx" ON "AccountSessionFollow" ("sourceDiscussionId");
CREATE INDEX "AccountSessionFollow_sourceExecutionRunSessionId_idx" ON "AccountSessionFollow" ("sourceExecutionRunSessionId");
CREATE INDEX "AccountSessionFollow_sourceWorkflowRunId_idx" ON "AccountSessionFollow" ("sourceWorkflowRunId");
