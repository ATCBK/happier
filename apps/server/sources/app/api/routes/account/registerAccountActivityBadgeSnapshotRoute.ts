import { z } from "zod/mini";
import { type Fastify } from "../../types";
import { computeAuthenticatedAccountActivityBadgeCount } from "@/app/activity/accountActivityBadge";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";

export function registerAccountActivityBadgeSnapshotRoute(app: Fastify): void {
    app.get(
        "/v1/account/activity/badge-snapshot",
        {
            schema: {
                response: {
                    200: z.object({
                        badgeCount: z.number().check(z.int(), z.nonnegative()),
                    }),
                },
            },
            preHandler: app.authenticate,
        },
        async (request, reply) => {
            const accountId = request.userId;
            const authentication = readSessionAccessAuthenticationFromRequest(request);
            const badgeCount = await computeAuthenticatedAccountActivityBadgeCount(accountId, authentication);

            return reply.send({ badgeCount });
        },
    );
}
