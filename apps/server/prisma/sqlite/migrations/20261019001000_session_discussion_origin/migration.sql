-- Discussion origin of a Session (moved out of the applied 20260930140000 migration).
ALTER TABLE "Session" ADD COLUMN "originDiscussionId" TEXT;
ALTER TABLE "Session" ADD COLUMN "originDiscussionParticipantSlotId" TEXT;
