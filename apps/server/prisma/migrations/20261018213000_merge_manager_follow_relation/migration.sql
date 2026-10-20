-- One-way 0.3 conversion; no dual manager writer.
-- Live readers take Session, SessionReportsTo and SessionFollowEdge in both orders, so take all three locks up front
-- Session first (nothing else is held while queueing for it), with a bounded wait; a busy moment fails cleanly instead of deadlocking (40P01 on the dev DB, 2026-10-18).
SET lock_timeout = '20s';
LOCK TABLE "Session", "SessionReportsTo", "SessionFollowEdge" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "SessionFollowEdge"
    ADD COLUMN "relation" TEXT NOT NULL DEFAULT 'follower',
    ADD COLUMN "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "managerSourceSessionId" TEXT,
    DROP CONSTRAINT "SessionFollowEdge_pkey",
    DROP CONSTRAINT "SessionFollowEdge_deliveredTurn_pair_check",
    ADD CONSTRAINT "SessionFollowEdge_pkey" PRIMARY KEY ("destinationSessionId", "sourceSessionId", "relation"),
    ADD CONSTRAINT "SessionFollowEdge_deliveredTurn_pair_check" CHECK ("deliveredTurnStatus" IS NULL OR "deliveredTurnId" IS NOT NULL),
    ADD CONSTRAINT "SessionFollowEdge_manager_relation_check" CHECK (
        ("relation" = 'manager' AND "managerSourceSessionId" IS NOT NULL AND "managerSourceSessionId" = "sourceSessionId")
        OR ("relation" = 'follower' AND "managerSourceSessionId" IS NULL)
    );
CREATE UNIQUE INDEX "SessionFollowEdge_managerSourceSessionId_key" ON "SessionFollowEdge" ("managerSourceSessionId");
INSERT INTO "SessionFollowEdge" ("sourceSessionId", "destinationSessionId", "relation", "attachedAt", "managerSourceSessionId", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus")
SELECT "sessionId", "leadSessionId", 'manager', "attachedAt", "sessionId", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus" FROM "SessionReportsTo";
DROP TABLE "SessionReportsTo";
