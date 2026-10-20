-- One-way 0.3 conversion: manager and ordinary follows keep independent progress.
CREATE TABLE "new_SessionFollowEdge" (
    "sourceSessionId" TEXT NOT NULL,
    "destinationSessionId" TEXT NOT NULL,
    "relation" TEXT NOT NULL DEFAULT 'follower',
    "attachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "managerSourceSessionId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'next_turn',
    "deliveredTranscriptSeq" INTEGER NOT NULL DEFAULT 0,
    "deliveredReadyEventSeq" INTEGER NOT NULL DEFAULT 0,
    "deliveredAgentStateVersion" INTEGER NOT NULL DEFAULT 0,
    "deliveredTurnId" TEXT,
    "deliveredTurnStatus" TEXT,
    PRIMARY KEY ("destinationSessionId", "sourceSessionId", "relation"),
    CONSTRAINT "SessionFollowEdge_manager_relation_check" CHECK (
        ("relation" = 'manager' AND "managerSourceSessionId" IS NOT NULL AND "managerSourceSessionId" = "sourceSessionId")
        OR ("relation" = 'follower' AND "managerSourceSessionId" IS NULL)
    ),
    CONSTRAINT "SessionFollowEdge_deliveredTurn_pair_check" CHECK ("deliveredTurnStatus" IS NULL OR "deliveredTurnId" IS NOT NULL),
    CONSTRAINT "SessionFollowEdge_deliveredTurn_status_check" CHECK ("deliveredTurnStatus" IS NULL OR "deliveredTurnStatus" IN ('completed', 'failed', 'cancelled')),
    CONSTRAINT "SessionFollowEdge_distinct_sessions_check" CHECK ("sourceSessionId" <> "destinationSessionId"),
    CONSTRAINT "SessionFollowEdge_mode_check" CHECK ("mode" IN ('next_turn', 'wake_on_human_change')),
    CONSTRAINT "SessionFollowEdge_frontier_nonnegative_check" CHECK ("deliveredTranscriptSeq" >= 0 AND "deliveredReadyEventSeq" >= 0 AND "deliveredAgentStateVersion" >= 0),
    CONSTRAINT "SessionFollowEdge_sourceSessionId_fkey" FOREIGN KEY ("sourceSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionFollowEdge_destinationSessionId_fkey" FOREIGN KEY ("destinationSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SessionFollowEdge" ("sourceSessionId", "destinationSessionId", "relation", "mode", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus")
SELECT "sourceSessionId", "destinationSessionId", 'follower', "mode", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus" FROM "SessionFollowEdge";
INSERT INTO "new_SessionFollowEdge" ("sourceSessionId", "destinationSessionId", "relation", "attachedAt", "managerSourceSessionId", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus")
SELECT "sessionId", "leadSessionId", 'manager', "attachedAt", "sessionId", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus" FROM "SessionReportsTo";
DROP TABLE "SessionFollowEdge";
ALTER TABLE "new_SessionFollowEdge" RENAME TO "SessionFollowEdge";
CREATE INDEX "SessionFollowEdge_sourceSessionId_idx" ON "SessionFollowEdge" ("sourceSessionId");
CREATE UNIQUE INDEX "SessionFollowEdge_managerSourceSessionId_key" ON "SessionFollowEdge" ("managerSourceSessionId");
DROP TABLE "SessionReportsTo";
