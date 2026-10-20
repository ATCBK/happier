-- Replace the 0.3-only mode in place, preserving all relation identity/progress.
ALTER TABLE "SessionFollowEdge" ADD COLUMN "policyJson" TEXT;
UPDATE "SessionFollowEdge" SET "policyJson" = CASE WHEN "relation" = 'manager' OR "sourceDiscussionId" IS NOT NULL THEN '{"preset":"important"}'
    WHEN "mode" = 'wake_on_human_change' THEN '{"preset":"custom","events":{"needs_you":{"decision":{"delivery":"quiet"},"approval":{"delivery":"quiet"},"blocked":{"delivery":"quiet"}},"finished":{"delivery":"quiet"},"failed_or_stopped":{"delivery":"quiet"},"stalled":{"delivery":"quiet"},"update_posted":{"delivery":"quiet"},"person_wrote":{"delivery":"interrupt"},"goal_changed":{"delivery":"quiet"},"message":{"delivery":"quiet"}}}'
    ELSE '{"preset":"custom","events":{"needs_you":{"decision":{"delivery":"quiet"},"approval":{"delivery":"quiet"},"blocked":{"delivery":"quiet"}},"finished":{"delivery":"quiet"},"failed_or_stopped":{"delivery":"quiet"},"stalled":{"delivery":"quiet"},"update_posted":{"delivery":"quiet"},"person_wrote":{"delivery":"quiet"},"goal_changed":{"delivery":"quiet"},"message":{"delivery":"quiet"}}}' END;
ALTER TABLE "SessionFollowEdge" ALTER COLUMN "policyJson" SET NOT NULL, DROP COLUMN "mode";
DROP TYPE "SessionFollowMode";
