-- Keep personal Follow in its current table while admitting non-Session sources.
CREATE TABLE "new_AccountSessionFollow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT,
    "sourceKey" TEXT,
    "sourceDiscussionId" TEXT,
    "sourceExecutionRunSessionId" TEXT,
    "sourceExecutionRunId" TEXT,
    "sourceWorkflowRunId" TEXT,
    "following" BOOLEAN NOT NULL DEFAULT true,
    "notificationLevel" TEXT NOT NULL DEFAULT 'important',
    "hasPersistentFollow" BOOLEAN NOT NULL DEFAULT true,
    "includeInVoice" BOOLEAN NOT NULL DEFAULT false,
    "voiceDeliveredFrontier" TEXT,
    "followPolicy" TEXT,
    "notifyOnce" TEXT,
    "deliveredDiscussionSeq" INTEGER,
    "deliveredExecutionRunTerminalEventId" TEXT,
    "deliveredWorkflowRunRevision" INTEGER,
    CONSTRAINT "AccountSessionFollow_source_identity_check" CHECK (
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
    CONSTRAINT "AccountSessionFollow_source_progress_check" CHECK (("deliveredDiscussionSeq" IS NULL OR "deliveredDiscussionSeq" >= 0)
        AND ("deliveredWorkflowRunRevision" IS NULL OR "deliveredWorkflowRunRevision" >= 0)),
    CONSTRAINT "AccountSessionFollow_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountSessionFollow_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountSessionFollow_sourceDiscussionId_fkey" FOREIGN KEY ("sourceDiscussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountSessionFollow_sourceExecutionRunSessionId_fkey" FOREIGN KEY ("sourceExecutionRunSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountSessionFollow_sourceWorkflowRunId_fkey" FOREIGN KEY ("sourceWorkflowRunId") REFERENCES "AutomationRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AccountSessionFollow" ("id", "accountId", "sessionId", "sourceKey", "following", "notificationLevel", "hasPersistentFollow", "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce")
SELECT 'legacy:' || row_number() OVER (ORDER BY "accountId", "sessionId"), "accountId", "sessionId", 'session:' || "sessionId", "following", "notificationLevel", "hasPersistentFollow", "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce"
FROM "AccountSessionFollow";
DROP TABLE "AccountSessionFollow";
ALTER TABLE "new_AccountSessionFollow" RENAME TO "AccountSessionFollow";
CREATE UNIQUE INDEX "AccountSessionFollow_accountId_sessionId_key" ON "AccountSessionFollow" ("accountId", "sessionId");
CREATE UNIQUE INDEX "AccountSessionFollow_accountId_sourceKey_key" ON "AccountSessionFollow" ("accountId", "sourceKey");
CREATE INDEX "AccountSessionFollow_sessionId_idx" ON "AccountSessionFollow" ("sessionId");
CREATE INDEX "AccountSessionFollow_sourceDiscussionId_idx" ON "AccountSessionFollow" ("sourceDiscussionId");
CREATE INDEX "AccountSessionFollow_sourceExecutionRunSessionId_idx" ON "AccountSessionFollow" ("sourceExecutionRunSessionId");
CREATE INDEX "AccountSessionFollow_sourceWorkflowRunId_idx" ON "AccountSessionFollow" ("sourceWorkflowRunId");
