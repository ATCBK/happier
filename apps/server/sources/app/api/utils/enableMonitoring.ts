import type { FastifyReply, FastifyRequest } from "fastify";
import type { Fastify } from "../types";
import {
    classifyHotEndpointFamily,
    httpHotEndpointRequestDurationHistogram,
    httpHotEndpointRequestsCounter,
    httpRequestDurationHistogram,
    httpRequestsCounter,
} from "@/app/monitoring/metrics/index";
import {
    createHealthyMonitoringResponse,
    createShuttingDownMonitoringResponse,
    type DatabaseReadinessProbe,
    type MonitoringReadinessEnv,
    sendDatabaseReadinessResponse,
} from "@/app/monitoring/readiness";
import { isShutdown } from "@/utils/process/shutdown";
import { redactHttpRequestUrlForLog } from "@/utils/logging/redactHttpRequestUrlForLog";
import { randomUUID } from 'node:crypto';
import { recordWebLatencyPhase, withWebLatencyTrace } from '@/utils/webLatencyTrace';

type EnableMonitoringOptions = Readonly<{
    env?: MonitoringReadinessEnv;
    databaseReadinessProbe?: DatabaseReadinessProbe;
}>;

export function enableMonitoring(app: Fastify, options: EnableMonitoringOptions = {}) {
    // Add metrics hooks
    app.addHook('onRequest', (request, _reply, done) => {
        request.startTime = Date.now();
        // Continue Fastify inside the diagnostic scope so authentication and DB
        // reads share it too. Caller headers and query values never supply ids.
        withWebLatencyTrace(process.env.HAPPIER_WEB_LATENCY_TRACE === '1' ? randomUUID() : null, done);
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url
            || redactHttpRequestUrlForLog(request.url)
            || 'unknown';
        const status = reply.statusCode.toString();
        recordWebLatencyPhase(`http.${method}.${request.routeOptions?.url ?? 'unmatched'}`, duration * 1000);

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status }, duration);

        const family = classifyHotEndpointFamily(route);
        if (family) {
            httpHotEndpointRequestsCounter.inc({ family, method, route, status });
            httpHotEndpointRequestDurationHistogram.observe({ family, method, route, status }, duration);
        }
    });

    const livenessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
        if (isShutdown()) {
            reply.code(503).send(createShuttingDownMonitoringResponse());
            return;
        }
        reply.send(createHealthyMonitoringResponse());
    };

    const readinessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
        await sendDatabaseReadinessResponse(reply, options);
    };

    app.get('/health', livenessHandler);
    app.get('/ready', readinessHandler);
}
