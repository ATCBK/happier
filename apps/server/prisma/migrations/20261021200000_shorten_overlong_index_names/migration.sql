-- MySQL cannot create these 65-character names, and PostgreSQL truncates them to 63.
-- Give every flavor the same short, explicit index names.
ALTER INDEX "ManagedMachine_homeId_custodianAccountId_archivedAt_createdAt_idx" RENAME TO "ManagedMachine_home_custodian_archived_idx";
ALTER INDEX "SessionFollowEdge_sourceExecutionRunSessionId_sourceExecutionRunId_idx" RENAME TO "SessionFollowEdge_executionRunSource_idx";
