import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema, UsageEventIngestRequestSchema, UsageNativeHistoryDeleteRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageModelPriceCatalogSchema } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { z } from "zod/mini";
import { inTx, type Tx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { captureUsageAnalyticsInTx, projectUsageAnalytics } from "@/app/usage/usageQueryService";
import { recordLegacyUsageReport, recordUsageEvent, deleteNativeUsageHistory } from "@/app/usage/usageWriteService";
import { LegacyUsageReportRouteBodySchema } from "@/app/usage/legacyUsageReportSchema";
import { type Fastify } from "../../types";
import { accountUsageRoutePaths } from "./accountUsageRoutePaths";
import { readUsageModelPriceCatalog, refreshUsageModelPriceCatalog } from '@/app/usage/usageModelPriceCatalog';
import { readCurrentSessionIdsInTx } from '@/app/session/access/sessionReadAdmission';
import { readSessionAccessAuthenticationFromRequest, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';

const LegacyUsageReportRouteResponseSchema = z.object({
    success: z.literal(true),
    reportId: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const UsageEventIngestRouteResponseSchema = z.object({
    success: z.literal(true),
    eventId: z.string(),
    createdAt: z.number(),
});

async function ensureReadableSessionIds(tx: Tx, accountId: string, sessionIds: readonly string[],
    authentication: SessionAccessAuthentication): Promise<boolean> {
    const requested = [...new Set(sessionIds)];
    const readable = await readCurrentSessionIdsInTx(tx, { accountId, sessionIds: requested, authentication });
    return readable.size === requested.length;
}

export function registerAccountUsageRoutes(app: Fastify): void {
    app.get(accountUsageRoutePaths.prices, {
        schema: { response: { 200: UsageModelPriceCatalogSchema } },
        preHandler: app.authenticate,
    }, async (_request, reply) => reply.send(await readUsageModelPriceCatalog()));

    app.post(accountUsageRoutePaths.pricesRefresh, {
        schema: { body: z.strictObject({}), response: { 200: UsageModelPriceCatalogSchema } },
        preHandler: app.authenticate,
    }, async (_request, reply) => reply.send(await refreshUsageModelPriceCatalog()));

    app.post(accountUsageRoutePaths.legacyQuery, {
        schema: {
            body: z.object({
                sessionId: z.nullish(z.string()),
                startTime: z.nullish(z.number().check(z.int(), z.positive())),
                endTime: z.nullish(z.number().check(z.int(), z.positive())),
                groupBy: z.nullish(z.enum(['hour', 'day'])),
            }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, startTime, endTime, groupBy } = request.body;
        const actualGroupBy = groupBy || 'day';

        try {
            const query = UsageAnalyticsQueryRequestSchema.parse({
                granularity: actualGroupBy, includeSeries: true,
                filters: sessionId ? { sessionIds: [sessionId] } : undefined,
                dateRange: startTime || endTime ? {
                    ...(startTime ? { startMs: startTime * 1000 } : {}),
                    // v1's retained millisecond instant is inclusive; v2 ranges are half-open.
                    ...(endTime ? { endMs: endTime * 1000 + 1 } : {}),
                } : undefined,
            });
            const snapshot = await inTx(async tx => {
                if (sessionId) {
                    if (!await ensureReadableSessionIds(tx, userId, [sessionId], readSessionAccessAuthenticationFromRequest(request))) {
                        return null;
                    }
                }
                return captureUsageAnalyticsInTx(tx, userId, query);
            }, { readOnly: true });
            if (!snapshot) return reply.code(404).send({ error: 'Session not found' });
            const result = projectUsageAnalytics(snapshot, query);
            return reply.send({
                usage: (result.series ?? []).map((bucket) => ({
                    timestamp: Math.floor(bucket.bucketStartMs / 1000), tokens: bucket.tokens,
                    cost: bucket.cost.effectiveUsd === undefined ? {} : { total: bucket.cost.effectiveUsd },
                    reportCount: bucket.eventCount,
                })),
                groupBy: actualGroupBy,
                totalReports: result.totals.eventCount,
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to query usage reports: ${error}`);
            return reply.code(500).send({ error: 'Failed to query usage reports' });
        }
    });

    app.post(accountUsageRoutePaths.analyticsQuery, {
        schema: {
            body: UsageAnalyticsQueryRequestSchema,
            response: {
                200: UsageAnalyticsQueryResponseSchema,
                404: z.object({ error: z.literal('Session not found') }),
                500: z.object({ error: z.literal('Failed to query usage analytics') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const snapshot = await inTx(async tx => {
                if (request.body.filters?.sessionIds?.length) {
                    const isReadable = await ensureReadableSessionIds(tx, request.userId, request.body.filters.sessionIds,
                        readSessionAccessAuthenticationFromRequest(request));
                    if (!isReadable) {
                        return null;
                    }
                }

                return captureUsageAnalyticsInTx(tx, request.userId, request.body);
            }, { readOnly: true });
            if (!snapshot) return reply.code(404).send({ error: 'Session not found' });
            return reply.send(projectUsageAnalytics(snapshot, request.body));
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to query usage analytics: ${error}`);
            return reply.code(500).send({ error: 'Failed to query usage analytics' });
        }
    });

    app.post(accountUsageRoutePaths.analyticsEventsIngest, {
        config: {
            restrictedCredentialBinding: {
                scope: "session",
                session: "body.sessionId",
                machine: "body.machineId",
                machineOptional: true,
            },
        },
        schema: {
            body: UsageEventIngestRequestSchema,
            response: {
                200: UsageEventIngestRouteResponseSchema,
                400: z.object({ error: z.enum(['Invalid parameters', 'Native Session link not found']) }),
                404: z.object({ error: z.enum(['Session not found', 'Machine not found']) }),
                500: z.object({ error: z.literal('Failed to save usage event') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const result = await recordUsageEvent(request.userId, request.body);
            if (!result.ok) {
                if (result.error === 'invalid-params' || result.error === 'native-link-not-found') return reply.code(400).send({ error: result.error === 'native-link-not-found' ? 'Native Session link not found' : 'Invalid parameters' });
                return reply.code(404).send({ error: result.error === 'machine-not-found' ? 'Machine not found' : 'Session not found' });
            }
            return reply.send({
                success: true,
                eventId: result.event.id,
                createdAt: result.event.createdAt.getTime(),
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to save usage event: ${error}`);
            return reply.code(500).send({ error: 'Failed to save usage event' });
        }
    });

    app.post(accountUsageRoutePaths.nativeHistoryDelete, {
        schema: {
            body: UsageNativeHistoryDeleteRequestSchema,
            response: {
                200: z.object({ success: z.literal(true), deletedEventCount: z.number().check(z.int(), z.minimum(0)) }),
                404: z.object({ error: z.literal('Machine not found') }),
                500: z.object({ error: z.literal('Failed to delete native usage history') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const result = await deleteNativeUsageHistory(request.userId, request.body);
            if (!result.ok) return reply.code(404).send({ error: 'Machine not found' });
            return reply.send({ success: true, deletedEventCount: result.deletedEventCount });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to delete native usage history: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete native usage history' });
        }
    });

    app.post(accountUsageRoutePaths.legacyReportsIngest, {
        schema: {
            body: LegacyUsageReportRouteBodySchema,
            response: {
                200: LegacyUsageReportRouteResponseSchema,
                400: z.object({ error: z.literal('Invalid parameters') }),
                404: z.object({ error: z.literal('Session not found') }),
                500: z.object({ error: z.literal('Failed to save usage report') }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const result = await recordLegacyUsageReport({
                accountId: request.userId,
                key: request.body.key,
                sessionId: request.body.sessionId,
                tokens: request.body.tokens,
                cost: request.body.cost,
            });

            if (!result.ok) {
                return reply.code(result.error === 'invalid-params' ? 400 : 404).send({
                    error: result.error === 'invalid-params' ? 'Invalid parameters' : 'Session not found',
                });
            }

            return reply.send({
                success: true,
                reportId: result.report.id,
                createdAt: result.report.createdAt.getTime(),
                updatedAt: result.report.updatedAt.getTime(),
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to save usage report: ${error}`);
            return reply.code(500).send({ error: 'Failed to save usage report' });
        }
    });
}
