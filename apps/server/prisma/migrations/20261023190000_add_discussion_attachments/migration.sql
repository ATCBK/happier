CREATE TABLE "DiscussionAttachment" (
    "blobId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "encryptionMode" TEXT NOT NULL,
    "storedSizeBytes" BIGINT NOT NULL,
    CONSTRAINT "DiscussionAttachment_pkey" PRIMARY KEY ("blobId")
);
CREATE UNIQUE INDEX "DiscussionAttachment_storageKey_key" ON "DiscussionAttachment"("storageKey");
CREATE INDEX "DiscussionAttachment_messageId_idx" ON "DiscussionAttachment"("messageId");
ALTER TABLE "DiscussionAttachment" ADD CONSTRAINT "DiscussionAttachment_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "DiscussionMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
