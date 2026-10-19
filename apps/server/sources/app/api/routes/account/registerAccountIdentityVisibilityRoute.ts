import {
    IdentityManagementDeniedError,
    setIdentityVisibilityInTx,
} from "@/app/auth/providers/accountIdentityLifecycle";
import { z } from "zod/mini";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";
import { isAccountIdentityEligibleForGenericPresentation } from "@/app/auth/methods/registry";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

export function registerAccountIdentityVisibilityRoute(app: Fastify): void {
    app.patch('/v1/account/identity/:provider', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string() }),
            body: z.object({ showOnProfile: z.boolean() }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.enum(['unsupported-provider', 'not-connected']) }),
                409: z.object({
                    error: z.literal('identity-management-denied'),
                    reason: z.enum(['required_by_team', 'last_login_method', 'management_unavailable']),
                }),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const providerId = request.params.provider.toString().trim().toLowerCase();
        if (!isAccountIdentityEligibleForGenericPresentation(requestHomeEnv, providerId)) {
            return reply.code(404).send({ error: "unsupported-provider" });
        }
        let result: { type: "ok" | "not-connected" };
        try {
            result = await inTx(async (tx) => {
                const connected = await setIdentityVisibilityInTx(tx, {
                    accountId: request.userId, provider: providerId, showOnProfile: request.body.showOnProfile,
                });
                if (!connected) return { type: "not-connected" as const };

                return { type: "ok" as const };
            });
        } catch (error) {
            if (error instanceof IdentityManagementDeniedError) {
                return reply.code(409).send({ error: 'identity-management-denied', reason: error.reason });
            }
            throw error;
        }

        if (result.type === "not-connected") {
            return reply.code(404).send({ error: "not-connected" });
        }

        return reply.send({ success: true });
    });
}
