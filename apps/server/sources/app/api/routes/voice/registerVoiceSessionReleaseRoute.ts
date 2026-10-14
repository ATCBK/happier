import { z } from "zod/mini";
import { isResolvedServerFeatureEnabledForGating, resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { db } from "@/storage/db";
import { type VoiceSessionReleaseBody, voiceSessionReleaseBodySchema } from "./voiceSessionLifecycleSchemas";
import { type Fastify } from "../../types";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { completeVoiceSession } from "./voiceSessionComplete";
import { createVoiceRouteAbortScope } from "./voiceRouteAbortScope";

export function registerVoiceSessionReleaseRoute(app: Fastify): void {
    app.post("/v1/voice/session/release", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "voice.sessionComplete"),
        },
        schema: {
            body: voiceSessionReleaseBodySchema,
            response: {
                200: z.object({ ok: z.literal(true) }),
                404: z.object({ ok: z.literal(false), reason: z.literal("not_found") }),
                503: z.object({ ok: z.literal(false), reason: z.literal("upstream_error") }),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const serverFeatures = resolveServerFeaturesForGating(requestHomeEnv);
        if (!isResolvedServerFeatureEnabledForGating(serverFeatures, "voice.happierVoice")) {
            return reply.code(404).send({ ok: false, reason: "not_found" as const });
        }

        const { leaseId } = request.body as VoiceSessionReleaseBody;
        try {
            const lease = await db.voiceSessionLease.findFirst({
                where: { id: leaseId, accountId: request.userId },
                select: { providerConversationId: true },
            });
            if (lease?.providerConversationId) {
                const abortScope = createVoiceRouteAbortScope(reply);
                const result = await completeVoiceSession({
                    requestHomeEnv,
                    userId: request.userId,
                    leaseId,
                    providerConversationId: lease.providerConversationId,
                    signal: abortScope.signal,
                }).finally(() => abortScope.dispose());
                if (!result.ok && result.reason === "upstream_error") {
                    return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
                }
            }
        } catch {
            return reply.code(503).send({ ok: false, reason: "upstream_error" as const });
        }

        // Deliberately existence-oblivious: release is idempotent and must not
        // disclose whether another Account owns the supplied lease id.
        // Without provider-attested completion, leave the reservation and quota intact.
        return reply.send({ ok: true as const });
    });
}
