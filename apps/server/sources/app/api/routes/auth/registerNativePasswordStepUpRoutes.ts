import { z } from "zod";
import { AccountEncryptionMigrateExternalAuthBindingDigestV1Schema, AccountEncryptionMigrateExternalAuthProofSchema } from '@happier-dev/protocol/account/encryptionMigrate';
import { PASSWORD_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import type { Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { isEffectiveHomeAuthMethodActionEnabled } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { PasswordHashOverloadedError } from "@/app/auth/password/passwordHashAdmission";
import { createNativePasswordFirstKeyStepUp } from "@/app/auth/password/nativePasswordFirstKeyStepUp";
import { requirePresentUser, PresentUserRequiredResponseSchema } from "@/app/api/utils/requirePresentUser";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

export function registerNativePasswordStepUpRoutes(app: Fastify): void {
    app.post("/v1/auth/email/step-up", {
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.email.stepUp") },
        schema: {
            body: z.object({ v: z.literal(1), password: z.string().max(PASSWORD_MAX_UTF8_BYTES_V1),
                purpose: z.literal("account_encryption_first_key"), requestDigest: AccountEncryptionMigrateExternalAuthBindingDigestV1Schema }).strict(),
            response: {
                200: z.object({ externalAuthProof: AccountEncryptionMigrateExternalAuthProofSchema }).strict(),
                401: z.object({ error: z.string() }).strict(),
                403: z.union([PresentUserRequiredResponseSchema, z.object({ error: z.literal("method_not_available") }).strict()]),
                503: z.object({ error: z.literal("password_hash_overloaded") }).strict(),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (!await isEffectiveHomeAuthMethodActionEnabled({ env: requestHomeEnv, methodId: "email_password", actionId: "login" })) {
            return reply.code(403).send({ error: "method_not_available" });
        }
        try {
            const externalAuthProof = await createNativePasswordFirstKeyStepUp({ accountId: request.userId,
                password: request.body.password, requestDigest: request.body.requestDigest });
            if (!externalAuthProof) return reply.code(401).send({ error: "authentication_failed" });
            return reply.send({ externalAuthProof });
        } catch (error) {
            if (error instanceof PasswordHashOverloadedError) return reply.code(503).send({ error: "password_hash_overloaded" });
            throw error;
        }
    });
}
