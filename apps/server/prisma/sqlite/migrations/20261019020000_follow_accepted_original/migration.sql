ALTER TABLE "SessionMessage" ADD COLUMN "acceptedFollowOriginalKey" TEXT;
CREATE INDEX "SessionMessage_accepted_follow_original_idx" ON "SessionMessage"("sessionId", "acceptedFollowOriginalKey");
