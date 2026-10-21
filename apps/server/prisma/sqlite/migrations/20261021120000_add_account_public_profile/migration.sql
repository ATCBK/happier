CREATE TABLE "AccountPublicProfile" (
    "accountId" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "policyJson" TEXT,
    "metadataJson" TEXT,
    "queryJson" TEXT,
    "snapshotJson" TEXT,
    "layoutJson" TEXT,
    "appearanceJson" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "publishedAt" DATETIME,
    "removedAt" DATETIME,
    "removedByAccountId" TEXT,
    "removalReason" TEXT,
    CONSTRAINT "AccountPublicProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
