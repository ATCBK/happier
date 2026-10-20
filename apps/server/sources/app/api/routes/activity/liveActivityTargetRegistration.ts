import { createHash } from "node:crypto";

import { HAPPIER_FOCUS_LIVE_ACTIVITY_NAME, LiveActivityRemoteTargetKindSchema, LiveActivityRemoteTransportModeSchema } from '@happier-dev/protocol/activity/live/remoteUpdates';
import { z } from "zod/mini";

export const LiveActivityTargetRegistrationSchema = z.strictObject({
        deviceId: z.string().check(z.trim(), z.minLength(1)),
        serverId: z.string().check(z.trim(), z.minLength(1)),
        sessionId: z.string().check(z.trim(), z.minLength(1)),
        activityInstanceKey: z.string().check(z.trim(), z.minLength(1)),
        activityId: z.string().check(z.trim(), z.minLength(1)),
        activityName: z.literal(HAPPIER_FOCUS_LIVE_ACTIVITY_NAME),
        transportMode: LiveActivityRemoteTransportModeSchema,
        bundleId: z.optional(z.string().check(z.trim(), z.minLength(1))),
        environment: z.optional(z.enum(["sandbox", "production"])),
        tokenKind: LiveActivityRemoteTargetKindSchema,
        rawToken: z.optional(z.string().check(z.trim(), z.minLength(1))),
        expoPushToken: z.optional(z.string().check(z.trim(), z.minLength(1))),
        clientServerUrl: z.optional(z.string().check(z.trim(), z.minLength(1))),
    });

export type LiveActivityTargetRegistration = z.infer<typeof LiveActivityTargetRegistrationSchema>;

export function buildLiveActivityTargetIdentityHash(
    accountId: string,
    input: LiveActivityTargetRegistration,
): string {
    return createHash("sha256")
        .update(JSON.stringify({
            accountId,
            deviceId: input.deviceId,
            serverId: input.serverId,
            sessionId: input.sessionId,
            activityInstanceKey: input.activityInstanceKey,
            activityId: input.activityId,
            activityName: input.activityName,
            transportMode: input.transportMode,
        }))
        .digest("hex");
}
