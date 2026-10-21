CREATE TABLE "AccountPublicProfile" (
    "accountId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "policyJson" TEXT,
    "metadataJson" TEXT,
    "queryJson" TEXT,
    "snapshotJson" TEXT,
    "layoutJson" TEXT,
    "appearanceJson" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removedByAccountId" TEXT,
    "removalReason" TEXT,
    CONSTRAINT "AccountPublicProfile_pkey" PRIMARY KEY ("accountId")
);
ALTER TABLE "AccountPublicProfile" ADD CONSTRAINT "AccountPublicProfile_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
