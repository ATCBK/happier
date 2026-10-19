-- Extend the existing Follow owner without replacing its accepted progress.
ALTER TABLE "SessionFollowEdge" ADD COLUMN "sourceKey" TEXT, ADD COLUMN "sourceDiscussionId" TEXT;
UPDATE "SessionFollowEdge" SET "sourceKey" = 'session:' || "sourceSessionId";
ALTER TABLE "SessionFollowEdge"
    DROP CONSTRAINT "SessionFollowEdge_pkey",
    DROP CONSTRAINT "SessionFollowEdge_manager_relation_check",
    ALTER COLUMN "sourceSessionId" DROP NOT NULL,
    ALTER COLUMN "sourceKey" SET NOT NULL,
    ADD CONSTRAINT "SessionFollowEdge_pkey" PRIMARY KEY ("destinationSessionId", "sourceKey", "relation"),
    ADD CONSTRAINT "SessionFollowEdge_source_identity_check" CHECK (
        ("sourceSessionId" IS NOT NULL AND "sourceDiscussionId" IS NULL AND "sourceKey" = 'session:' || "sourceSessionId")
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NOT NULL AND "sourceKey" = 'discussion:' || "sourceDiscussionId")
    ),
    ADD CONSTRAINT "SessionFollowEdge_manager_relation_check" CHECK (
        ("relation" = 'manager' AND "sourceSessionId" IS NOT NULL AND "managerSourceSessionId" IS NOT NULL AND "managerSourceSessionId" = "sourceSessionId")
        OR ("relation" = 'follower' AND "managerSourceSessionId" IS NULL)
    ),
    ADD CONSTRAINT "SessionFollowEdge_sourceDiscussionId_fkey" FOREIGN KEY ("sourceDiscussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "SessionFollowEdge_session_source_relation_key" ON "SessionFollowEdge" ("destinationSessionId", "sourceSessionId", "relation");
CREATE UNIQUE INDEX "SessionFollowEdge_discussion_source_relation_key" ON "SessionFollowEdge" ("destinationSessionId", "sourceDiscussionId", "relation");
CREATE INDEX "SessionFollowEdge_sourceDiscussionId_idx" ON "SessionFollowEdge" ("sourceDiscussionId");
INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceDiscussionId", "destinationSessionId", "mode", "deliveredTranscriptSeq")
SELECT 'discussion:' || d."id", d."id", p."sessionId", 'wake_on_human_change', d."messageSeq"
FROM "DiscussionParticipant" p JOIN "Discussion" d ON d."id" = p."discussionId"
WHERE p."sessionId" IS NOT NULL AND p."removedAt" IS NULL;
