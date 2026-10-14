import { z } from "zod/mini";
import { isResolvedServerFeatureEnabledForGating, resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { createVoiceRouteAbortScope } from "./voiceRouteAbortScope";
import { type VoiceSessionLifecycleBody, voiceSessionLifecycleBodySchema } from "./voiceSessionLifecycleSchemas";
import { completeVoiceSession } from "./voiceSessionComplete";
import { type Fastify } from "../../types";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

export function registerVoiceSessionCompleteRoute(app: Fastify): void {
    app.post('/v1/voice/session/complete', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "voice.sessionComplete"),
        },
        schema: {
            body: voiceSessionLifecycleBodySchema,
            response: {
                200: z.object({
                    ok: z.literal(true),
                    durationSeconds: z.number().check(z.int(), z.minimum(0)),
                }),
                404: z.object({
                    ok: z.literal(false),
                    reason: z.literal("not_found"),
                }),
                503: z.object({
                    ok: z.literal(false),
                    reason: z.literal("upstream_error"),
                }),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const userId = request.userId;
        const { leaseId, providerConversationId } = request.body as VoiceSessionLifecycleBody;
        const serverFeatures = resolveServerFeaturesForGating(requestHomeEnv);
        if (!isResolvedServerFeatureEnabledForGating(serverFeatures, "voice.happierVoice")) {
            return reply.code(404).send({ ok: false, reason: "not_found" as const });
        }

        const providerAbortScope = createVoiceRouteAbortScope(reply);
        const result = await completeVoiceSession({
            requestHomeEnv, userId, leaseId, providerConversationId, signal: providerAbortScope.signal,
        }).finally(() => providerAbortScope.dispose());
        return result.ok
            ? reply.send(result)
            : reply.code(result.reason === "not_found" ? 404 : 503).send(result);
    });
}
