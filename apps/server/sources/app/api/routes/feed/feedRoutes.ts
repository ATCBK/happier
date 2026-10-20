import { z } from "zod/mini";
import { Fastify } from "../../types";
import { FeedBodySchema } from "@/app/feed/types";
import { feedGet } from "@/app/feed/feedGet";
import { Context } from "@/context";
import { db } from "@/storage/db";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";

export function feedRoutes(app: Fastify) {
    app.get('/v1/feed', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "feed"),
        },
        schema: {
            querystring: z.optional(z.object({
                before: z.optional(z.string()),
                after: z.optional(z.string()),
                limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(200)), 50)
            })),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        id: z.string(),
                        body: FeedBodySchema,
                        repeatKey: z.nullable(z.string()),
                        cursor: z.string(),
                        createdAt: z.number()
                    })),
                    hasMore: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const items = await feedGet(db, Context.create(request.userId), {
            cursor: {
                before: request.query?.before,
                after: request.query?.after
            },
            limit: request.query?.limit
        });
        return reply.send({ items: items.items, hasMore: items.hasMore });
    });
}
