import { z } from "zod/mini";
import { db } from "@/storage/db";
import { Context } from "@/context";
import { InvalidUsernameError, UsernameTakenError, usernameCheck, usernameRelease, usernameUpdate } from "@/app/social/usernameUpdate";
import { resolveFriendsPolicyFromServerFeatures } from "@/app/social/resolveFriendsPolicyFromServerFeatures";
import { type Fastify } from "../../types";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import {
    AccountUsernameUpdateRequestV1Schema, AccountUsernameUpdateResponseV1Schema,
    AccountUsernameCheckRequestV1Schema, AccountUsernameCheckResponseV1Schema,
    AccountUsernameReleaseRequestV1Schema, AccountUsernameReleaseResponseV1Schema,
} from "@happier-dev/protocol/account/profile";

/** PP-1 retains existing Friends eligibility; profile capability admission is PP-2. */
async function readUsernameEligibilityError(accountId: string, env: NodeJS.ProcessEnv) {
    const policy = resolveFriendsPolicyFromServerFeatures(env);
    if (!policy.enabled) return "friends-disabled" as const;
    if (policy.allowUsername) return null;
    if (!policy.requiredIdentityProviderId) return "username-disabled" as const;
    const current = await db.account.findUnique({
        where: { id: accountId },
        select: { AccountIdentity: { where: { provider: policy.requiredIdentityProviderId }, select: { id: true }, take: 1 } },
    });
    return current?.AccountIdentity.length ? null : "username-disabled" as const;
}

const eligibilityErrorSchema = z.strictObject({ error: z.enum(["invalid-username", "username-disabled", "friends-disabled"]) });

export function registerAccountUsernameRoute(app: Fastify): void {
    app.post('/v1/account/username', {
        preHandler: app.authenticate,
        schema: {
            body: AccountUsernameUpdateRequestV1Schema,
            response: {
                200: AccountUsernameUpdateResponseV1Schema,
                400: eligibilityErrorSchema,
                409: z.object({ error: z.literal('username-taken') }),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const error = await readUsernameEligibilityError(request.userId, requestHomeEnv);
        if (error) return reply.code(400).send({ error });

        try {
            const username = await usernameUpdate(Context.create(request.userId), request.body.username, requestHomeEnv);
            return reply.send({ username });
        } catch (e) {
            if (e instanceof InvalidUsernameError) return reply.code(400).send({ error: "invalid-username" });
            if (e instanceof UsernameTakenError) {
                return reply.code(409).send({ error: 'username-taken' });
            }
            throw e;
        }

    });

    app.post("/v1/account/username/check", {
        preHandler: app.authenticate,
        schema: { body: AccountUsernameCheckRequestV1Schema, response: { 200: AccountUsernameCheckResponseV1Schema, 400: eligibilityErrorSchema } },
    }, async (request, reply) => {
        const env = await readRequestHomeEnv(request);
        const error = await readUsernameEligibilityError(request.userId, env);
        if (error) return reply.code(400).send({ error });
        return reply.send(await usernameCheck(request.userId, request.body.username, env));
    });

    app.post("/v1/account/username/release", {
        preHandler: app.authenticate,
        schema: { body: AccountUsernameReleaseRequestV1Schema, response: { 200: AccountUsernameReleaseResponseV1Schema, 400: eligibilityErrorSchema } },
    }, async (request, reply) => {
        const env = await readRequestHomeEnv(request);
        const error = await readUsernameEligibilityError(request.userId, env);
        if (error) return reply.code(400).send({ error });
        return reply.send(await usernameRelease(Context.create(request.userId), env));
    });
}
