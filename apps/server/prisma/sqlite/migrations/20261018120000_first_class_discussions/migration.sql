-- Preserve legacy identities, ciphertext/plaintext bytes, history and private cursors.
-- Legacy Session ciphertext has no Discussion-owned key. Preserve its bytes with
-- empty owner material and no recipient envelopes: readers report key unavailable.
-- Normalize only colliding retry identities and their collision closure to the
-- existing resource ids. Leave collective grants on the Session: their history
-- horizons cannot be represented by Discussion grants without broadening access.

CREATE TABLE "Discussion" (
    "id" TEXT NOT NULL,
    "ownerAccountId" TEXT NOT NULL,
    "encryptionMode" TEXT NOT NULL,
    "dataEncryptionKey" BLOB NOT NULL,
    "anchorV1" JSONB,
    "anchorSessionId" TEXT,
    "creationLocalId" TEXT NOT NULL,
    "creationEqualityEvidenceV1" JSONB NOT NULL,
    "createdByAccountId" TEXT,
    "titleContent" JSONB NOT NULL,
    "messageSeq" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Discussion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Discussion_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Discussion_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "DiscussionMessage" (
    "id" TEXT NOT NULL,
    "discussionId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "requestEqualityEvidenceV1" JSONB NOT NULL,
    "seq" INTEGER NOT NULL,
    "authorAccountId" TEXT,
    "producerV1" JSONB,
    "replyTargetV1" JSONB,
    "addressingV1" JSONB,
    "content" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionMessage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DiscussionMessage_discussionId_fkey" FOREIGN KEY ("discussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionMessage_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "DiscussionMessageMention" (
    "messageId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionMessageMention_pkey" PRIMARY KEY ("messageId", "accountId"),
    CONSTRAINT "DiscussionMessageMention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DiscussionMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionMessageMention_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DiscussionReadState" (
    "discussionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lastReadSeq" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiscussionReadState_pkey" PRIMARY KEY ("discussionId", "accountId"),
    CONSTRAINT "DiscussionReadState_discussionId_fkey" FOREIGN KEY ("discussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionReadState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DiscussionAccountGrant" (
    "discussionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionAccountGrant_pkey" PRIMARY KEY ("discussionId", "accountId"),
    CONSTRAINT "DiscussionAccountGrant_discussionId_fkey" FOREIGN KEY ("discussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionAccountGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionAccountGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DiscussionTeamGrant" (
    "discussionId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionTeamGrant_pkey" PRIMARY KEY ("discussionId", "teamId"),
    CONSTRAINT "DiscussionTeamGrant_discussionId_fkey" FOREIGN KEY ("discussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionTeamGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionTeamGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DiscussionGroupGrant" (
    "discussionId" TEXT NOT NULL,
    "teamGroupId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupGrant_pkey" PRIMARY KEY ("discussionId", "teamGroupId"),
    CONSTRAINT "DiscussionGroupGrant_discussionId_fkey" FOREIGN KEY ("discussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionGroupGrant_teamGroupId_fkey" FOREIGN KEY ("teamGroupId") REFERENCES "TeamGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionGroupGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DiscussionKeyEnvelope" (
    "discussionId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "encryptedDataKey" BLOB NOT NULL,
    "recipientContentPublicKeyFingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiscussionKeyEnvelope_pkey" PRIMARY KEY ("discussionId", "recipientAccountId"),
    CONSTRAINT "DiscussionKeyEnvelope_discussionId_fkey" FOREIGN KEY ("discussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionKeyEnvelope_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DiscussionParticipant" (
    "discussionId" TEXT NOT NULL,
    "participantSlotId" TEXT NOT NULL,
    "sessionId" TEXT,
    "modelLaunch" JSONB,
    "createdByAccountId" TEXT,
    "removedAt" DATETIME,
    "answerPolicy" TEXT NOT NULL DEFAULT 'when_addressed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiscussionParticipant_pkey" PRIMARY KEY ("discussionId", "participantSlotId"),
    CONSTRAINT "DiscussionParticipant_discussionId_fkey" FOREIGN KEY ("discussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscussionParticipant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- UNION deduplicates the closure; each step adds an existing row at most once.
WITH RECURSIVE "_DiscussionRetryNormalization" ("id", "createdByAccountId") AS (
    SELECT d."id", d."createdByAccountId" FROM "SessionDiscussion" d
    INNER JOIN (
        SELECT "createdByAccountId", "creationLocalId" FROM "SessionDiscussion"
        WHERE "createdByAccountId" IS NOT NULL
        GROUP BY "createdByAccountId", "creationLocalId" HAVING COUNT(*) > 1
    ) collisions ON collisions."createdByAccountId" = d."createdByAccountId" AND collisions."creationLocalId" = d."creationLocalId"
    UNION
    SELECT d."id", d."createdByAccountId" FROM "SessionDiscussion" d
    INNER JOIN "_DiscussionRetryNormalization" normalized
        ON d."createdByAccountId" = normalized."createdByAccountId" AND d."creationLocalId" = normalized."id"
)
INSERT INTO "Discussion" ("id", "ownerAccountId", "encryptionMode", "dataEncryptionKey", "anchorV1", "anchorSessionId", "creationLocalId", "creationEqualityEvidenceV1", "createdByAccountId", "titleContent", "messageSeq", "lastMessageAt", "archivedAt", "createdAt", "updatedAt")
SELECT d."id", COALESCE(d."createdByAccountId", s."accountId"), a."encryptionMode",
    CASE WHEN s."encryptionMode" = 'plain' AND a."encryptionMode" = 'plain' AND json_extract(d."titleContent", '$.t') = 'plain'
        AND NOT EXISTS (SELECT 1 FROM "SessionDiscussionMessage" m WHERE m."discussionId" = d."id" AND json_extract(m."content", '$.t') IS NOT 'plain')
        THEN CAST('{"t":"plain","v":null}' AS BLOB) ELSE X'' END,
    json_object('kind', 'session', 'sessionId', d."sessionId"), d."sessionId",
    CASE WHEN EXISTS (SELECT 1 FROM "_DiscussionRetryNormalization" normalized WHERE normalized."id" = d."id") THEN d."id" ELSE d."creationLocalId" END,
    d."creationEqualityEvidenceV1", d."createdByAccountId", d."titleContent", d."messageSeq", d."lastMessageAt", d."archivedAt", d."createdAt", d."updatedAt"
FROM "SessionDiscussion" d LEFT JOIN "Session" s ON s."id" = d."sessionId" LEFT JOIN "Account" a ON a."id" = COALESCE(d."createdByAccountId", s."accountId");

INSERT INTO "DiscussionMessage" ("id", "discussionId", "localId", "requestEqualityEvidenceV1", "seq", "authorAccountId", "producerV1", "content", "createdAt")
SELECT "id", "discussionId", "localId", "requestEqualityEvidenceV1", "seq", "authorAccountId", "producerV1", "content", "createdAt" FROM "SessionDiscussionMessage";

INSERT INTO "DiscussionMessageMention" ("messageId", "accountId", "createdAt")
SELECT "messageId", "accountId", "createdAt" FROM "SessionDiscussionMessageMention";

INSERT INTO "DiscussionReadState" ("discussionId", "accountId", "lastReadSeq", "updatedAt")
SELECT "discussionId", "accountId", "lastReadSeq", "updatedAt" FROM "SessionDiscussionReadState";

-- Retain the original Session owner's management and direct recipients' access.
INSERT INTO "DiscussionAccountGrant" ("discussionId", "accountId", "accessLevel", "createdByAccountId", "createdAt")
SELECT d."id", s."accountId", 'admin', d."ownerAccountId", d."createdAt"
FROM "Discussion" d INNER JOIN "SessionDiscussion" old ON old."id" = d."id"
INNER JOIN "Session" s ON s."id" = old."sessionId"
WHERE s."accountId" <> d."ownerAccountId";

INSERT INTO "DiscussionAccountGrant" ("discussionId", "accountId", "accessLevel", "createdByAccountId", "createdAt")
SELECT d."id", share."sharedWithUserId", share."accessLevel", share."sharedByUserId", share."createdAt"
FROM "Discussion" d INNER JOIN "SessionDiscussion" old ON old."id" = d."id"
INNER JOIN "Session" s ON s."id" = old."sessionId"
INNER JOIN "SessionShare" share ON share."sessionId" = old."sessionId"
WHERE share."sharedWithUserId" <> d."ownerAccountId" AND share."sharedWithUserId" <> s."accountId";

CREATE UNIQUE INDEX "Discussion_createdByAccountId_creationLocalId_key" ON "Discussion" ("createdByAccountId", "creationLocalId");
CREATE INDEX "Discussion_ownerAccountId_archivedAt_lastMessageAt_id_idx" ON "Discussion" ("ownerAccountId", "archivedAt", "lastMessageAt", "id");
CREATE INDEX "Discussion_anchorSessionId_archivedAt_lastMessageAt_idx" ON "Discussion" ("anchorSessionId", "archivedAt", "lastMessageAt");
CREATE UNIQUE INDEX "DiscussionMessage_discussionId_localId_key" ON "DiscussionMessage" ("discussionId", "localId");
CREATE UNIQUE INDEX "DiscussionMessage_discussionId_seq_key" ON "DiscussionMessage" ("discussionId", "seq");
CREATE INDEX "DiscussionMessage_discussionId_seq_idx" ON "DiscussionMessage" ("discussionId", "seq");
CREATE INDEX "DiscussionMessage_authorAccountId_createdAt_idx" ON "DiscussionMessage" ("authorAccountId", "createdAt");
CREATE INDEX "DiscussionMessageMention_accountId_createdAt_idx" ON "DiscussionMessageMention" ("accountId", "createdAt");
CREATE INDEX "DiscussionReadState_accountId_discussionId_idx" ON "DiscussionReadState" ("accountId", "discussionId");
CREATE INDEX "DiscussionAccountGrant_accountId_discussionId_idx" ON "DiscussionAccountGrant" ("accountId", "discussionId");
CREATE INDEX "DiscussionTeamGrant_teamId_discussionId_idx" ON "DiscussionTeamGrant" ("teamId", "discussionId");
CREATE INDEX "DiscussionGroupGrant_teamGroupId_discussionId_idx" ON "DiscussionGroupGrant" ("teamGroupId", "discussionId");
CREATE INDEX "DiscussionKeyEnvelope_recipientAccountId_discussionId_idx" ON "DiscussionKeyEnvelope" ("recipientAccountId", "discussionId");
CREATE INDEX "DiscussionParticipant_sessionId_discussionId_idx" ON "DiscussionParticipant" ("sessionId", "discussionId");
CREATE UNIQUE INDEX "DiscussionParticipant_discussionId_sessionId_key" ON "DiscussionParticipant" ("discussionId", "sessionId");

DROP TABLE "SessionDiscussionMessageMention";
DROP TABLE "SessionDiscussionReadState";
DROP TABLE "SessionDiscussionMessage";
DROP TABLE "SessionDiscussion";
