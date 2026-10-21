ALTER TABLE "Account"
ADD COLUMN "usernameAutoFillEnabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Account"
SET "usernameAutoFillEnabled" = false
WHERE "username" IS NOT NULL;

CREATE TABLE "ReleasedUsername" (
    "username" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReleasedUsername_pkey" PRIMARY KEY ("username")
);
