ALTER TABLE "Artifact" ADD COLUMN "kind" TEXT;
CREATE INDEX "Artifact_accountId_kind_idx" ON "Artifact"("accountId", "kind");
