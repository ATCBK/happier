-- One-way 0.3 contraction. Keep original one-shot and Voice frontiers intact.
-- Explicit policies remain authoritative; only policy-absent scalar choices convert.
UPDATE "AccountSessionFollow"
SET "followPolicy" = CASE
    WHEN "includeInVoice" = true AND "notificationLevel" = 'all_messages' THEN '{"preset":"everything","voice":true}'
    WHEN "includeInVoice" = true AND "notificationLevel" = 'important' THEN '{"preset":"important","voice":true}'
    WHEN "includeInVoice" = true THEN '{"preset":"custom","events":{"needs_you":{"decision":{"delivery":"off","voice":true},"approval":{"delivery":"off","voice":true},"blocked":{"delivery":"off","voice":true}},"finished":{"delivery":"off","voice":true},"failed_or_stopped":{"delivery":"off","voice":true},"stalled":{"delivery":"off","voice":true},"update_posted":{"delivery":"off","voice":true},"person_wrote":{"delivery":"off","voice":true},"goal_changed":{"delivery":"off","voice":true},"message":{"delivery":"off","voice":true}}}'
    WHEN "notificationLevel" = 'important' THEN '{"preset":"important"}'
    WHEN "notificationLevel" = 'all_messages' THEN '{"preset":"everything"}'
    ELSE '{"preset":"custom","events":{}}'
END
WHERE "followPolicy" IS NULL AND "following" = true
    AND ("hasPersistentFollow" = true OR "includeInVoice" = true);
UPDATE "AccountSessionFollow" SET "includeInVoice" = false;
ALTER TABLE "AccountSessionFollow" DROP COLUMN "notificationLevel";
