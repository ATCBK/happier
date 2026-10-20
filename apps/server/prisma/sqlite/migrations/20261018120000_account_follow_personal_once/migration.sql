ALTER TABLE "AccountSessionFollow" ADD COLUMN "followPolicy" TEXT;
ALTER TABLE "AccountSessionFollow" ADD COLUMN "notifyOnce" TEXT;
ALTER TABLE "AccountSessionFollow" ADD COLUMN "hasPersistentFollow" BOOLEAN NOT NULL DEFAULT true;
