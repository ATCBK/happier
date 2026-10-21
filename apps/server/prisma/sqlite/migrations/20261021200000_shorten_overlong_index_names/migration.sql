-- Give every flavor the same short, explicit index names.
DROP INDEX IF EXISTS "ManagedMachine_homeId_custodianAccountId_archivedAt_createdAt_idx";
CREATE INDEX "ManagedMachine_home_custodian_archived_idx" ON "ManagedMachine"("homeId", "custodianAccountId", "archivedAt", "createdAt");
DROP INDEX IF EXISTS "SessionFollowEdge_sourceExecutionRunSessionId_sourceExecutionRunId_idx";
CREATE INDEX "SessionFollowEdge_executionRunSource_idx" ON "SessionFollowEdge" ("sourceExecutionRunSessionId", "sourceExecutionRunId");
