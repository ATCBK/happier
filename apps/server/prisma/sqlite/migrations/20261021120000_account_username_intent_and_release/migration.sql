ALTER TABLE "Account"
ADD COLUMN "usernameAutoFillEnabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Account"
SET "usernameAutoFillEnabled" = false
WHERE "username" IS NOT NULL;

CREATE TABLE "ReleasedUsername" (
    "username" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL
);
