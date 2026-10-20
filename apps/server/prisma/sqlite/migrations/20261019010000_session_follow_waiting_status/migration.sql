-- Expand only the delivered-status constraint, retaining every attachment and frontier.
CREATE TABLE "new_SessionFollowEdge" (
    "sourceKey" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "sourceDiscussionId" TEXT,
    "destinationSessionId" TEXT NOT NULL,
    "relation" TEXT NOT NULL DEFAULT 'follower',
    "attachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "managerSourceSessionId" TEXT,
    "policyJson" TEXT NOT NULL,
    "deliveredTranscriptSeq" INTEGER NOT NULL DEFAULT 0,
    "deliveredReadyEventSeq" INTEGER NOT NULL DEFAULT 0,
    "deliveredAgentStateVersion" INTEGER NOT NULL DEFAULT 0,
    "deliveredTurnId" TEXT,
    "deliveredTurnStatus" TEXT,
    PRIMARY KEY ("destinationSessionId", "sourceKey", "relation"),
    CONSTRAINT "SessionFollowEdge_source_identity_check" CHECK (
        ("sourceSessionId" IS NOT NULL AND "sourceDiscussionId" IS NULL AND "sourceKey" = 'session:' || "sourceSessionId")
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NOT NULL AND "sourceKey" = 'discussion:' || "sourceDiscussionId")
    ),
    CONSTRAINT "SessionFollowEdge_manager_relation_check" CHECK (
        ("relation" = 'manager' AND "sourceSessionId" IS NOT NULL AND "managerSourceSessionId" IS NOT NULL AND "managerSourceSessionId" = "sourceSessionId")
        OR ("relation" = 'follower' AND "managerSourceSessionId" IS NULL)
    ),
    CONSTRAINT "SessionFollowEdge_deliveredTurn_pair_check" CHECK ("deliveredTurnStatus" IS NULL OR "deliveredTurnId" IS NOT NULL),
    CONSTRAINT "SessionFollowEdge_deliveredTurn_status_check" CHECK ("deliveredTurnStatus" IS NULL OR "deliveredTurnStatus" IN ('completed', 'failed', 'cancelled', 'waiting')),
    CONSTRAINT "SessionFollowEdge_distinct_sessions_check" CHECK ("sourceSessionId" <> "destinationSessionId"),
    CONSTRAINT "SessionFollowEdge_frontier_nonnegative_check" CHECK ("deliveredTranscriptSeq" >= 0 AND "deliveredReadyEventSeq" >= 0 AND "deliveredAgentStateVersion" >= 0),
    CONSTRAINT "SessionFollowEdge_sourceSessionId_fkey" FOREIGN KEY ("sourceSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionFollowEdge_sourceDiscussionId_fkey" FOREIGN KEY ("sourceDiscussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionFollowEdge_destinationSessionId_fkey" FOREIGN KEY ("destinationSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SessionFollowEdge" ("sourceKey", "sourceSessionId", "sourceDiscussionId", "destinationSessionId", "relation", "attachedAt", "managerSourceSessionId", "policyJson", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus")
SELECT "sourceKey", "sourceSessionId", "sourceDiscussionId", "destinationSessionId", "relation", "attachedAt", "managerSourceSessionId", "policyJson", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus" FROM "SessionFollowEdge";
DROP TABLE "SessionFollowEdge";
ALTER TABLE "new_SessionFollowEdge" RENAME TO "SessionFollowEdge";
CREATE UNIQUE INDEX "SessionFollowEdge_session_source_relation_key" ON "SessionFollowEdge" ("destinationSessionId", "sourceSessionId", "relation");
CREATE UNIQUE INDEX "SessionFollowEdge_discussion_source_relation_key" ON "SessionFollowEdge" ("destinationSessionId", "sourceDiscussionId", "relation");
CREATE UNIQUE INDEX "SessionFollowEdge_managerSourceSessionId_key" ON "SessionFollowEdge" ("managerSourceSessionId");
CREATE INDEX "SessionFollowEdge_sourceSessionId_idx" ON "SessionFollowEdge" ("sourceSessionId");
CREATE INDEX "SessionFollowEdge_sourceDiscussionId_idx" ON "SessionFollowEdge" ("sourceDiscussionId");
