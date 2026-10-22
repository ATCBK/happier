import fastify, { errorCodes, type FastifyInstance, type FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { constants } from 'node:os';
import { AxiosError } from 'axios';
import type { ManagedServiceRequest } from '@happier-dev/plugin-sdk/managed-services';
import { ProviderPublicHeadersV1Schema } from '@happier-dev/protocol/providers/public-headers';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_ENVELOPE_MAX_BYTES_V1, TeamCredentialProviderBrokerApplicationCarrierRequestV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import type { TeamCredentialUsageLimitDenialV1 } from '@happier-dev/protocol/teams';

import { startFirstBytesLocalCapabilityProxy, type FirstBytesLocalCapabilityProxy } from '@/daemon/peer/mediation/loopback/firstBytesLocalCapability';
import type {
    ProviderBrokerApplicationStreamLifetime,
    ProviderBrokerAuthenticatedStreamContext,
    ProviderBrokerRequestHandler,
} from './providerBrokerRequestHandler';
import { PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER } from './providerBrokerPrivateProtocol';
import { logger } from '@/ui/logger';
export { PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER } from './providerBrokerPrivateProtocol';

export type ProviderBrokerApplicationStreamTarget = Readonly<{
    port: number;
    localCapability: string;
}>;

export type StartedProviderBrokerApplicationServer = Readonly<{
    app: FastifyInstance;
    /** Runner-owned access endpoint; its request owner obtains current daemon custody. */
    localConsumerEndpointUrl?: string;
    createStreamTarget(
        context: ProviderBrokerAuthenticatedStreamContext,
        admissionSignal?: AbortSignal,
    ): Promise<ProviderBrokerApplicationStreamTarget>;
    close(): Promise<void>;
}>;

const RESPONSE_HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
// These are diagnostic classifications, never arbitrary error properties:
// Provider exceptions can contain credentials even in their name/code fields.
const APPLICATION_ERROR_NAMES = new Set([
    'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
    'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError',
    'AxiosError', 'CanceledError', 'ZodError', '$ZodError', 'FastifyError',
]);
export const PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER =
    'x-happier-provider-broker-limit-metric' as const;
export const PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER =
    'x-happier-provider-broker-limit-remaining' as const;
export const PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER =
    'x-happier-provider-broker-limit-resets-at' as const;

type ProviderBrokerApplicationFailureReply = Readonly<{
    header(name: string, value: string): unknown;
    code(statusCode: number): Readonly<{
        send(payload?: unknown): unknown;
    }>;
}>;

type ProviderBrokerApplicationFailure = Extract<Awaited<ReturnType<ProviderBrokerRequestHandler>>, { ok: false }>;

/**
 * The refusal an Agent can actually show. Providers' own error bodies share
 * this outer shape (`error.type` / `error.message`), so a refused brokered
 * request lands in the transcript as a named reason with its recovery facts
 * instead of an empty 403. It carries only the recipient-safe exhaustion
 * facts the headers already disclose.
 */
export type ProviderBrokerApplicationFailureBodyV1 = Readonly<{
    type: 'error';
    error: Readonly<{
        type: 'permission_error';
        code: ProviderBrokerApplicationFailure['reasonCode'];
        /**
         * The resource the recipient selected for this Session. It is already
         * theirs to see in the picker, and it is what lets the Session runtime
         * attribute the refusal to one shared credential instead of the Agent.
         */
        resourceId?: string;
        message: string;
        usageLimit?: TeamCredentialUsageLimitDenialV1;
    }>;
}>;

function providerBrokerApplicationFailureBody(
    response: ProviderBrokerApplicationFailure,
    resourceId: string | undefined,
): ProviderBrokerApplicationFailureBodyV1 {
    const usageLimit = response.reasonCode === 'team_credential_usage_limit' ? response.usageLimit : undefined;
    const message = usageLimit
        ? `Happier refused this request: the shared credential's ${usageLimit.metric} limit is reached `
            + `(${usageLimit.remaining} remaining, resets ${usageLimit.resetsAtUtc}).`
        : `Happier refused this request: ${response.reasonCode}.`;
    return {
        type: 'error',
        error: {
            type: 'permission_error',
            code: response.reasonCode,
            ...(resourceId ? { resourceId } : {}),
            message,
            ...(usageLimit ? { usageLimit } : {}),
        },
    };
}

export function writeProviderBrokerApplicationFailure(
    reply: ProviderBrokerApplicationFailureReply,
    response: ProviderBrokerApplicationFailure,
    resourceId?: string,
) {
    reply.header(PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER, response.reasonCode);
    if (response.reasonCode === 'team_credential_usage_limit' && response.usageLimit) {
        reply.header(PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER, response.usageLimit.metric);
        reply.header(PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER, response.usageLimit.remaining);
        reply.header(PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER, response.usageLimit.resetsAtUtc);
    }
    reply.header('content-type', 'application/json');
    return reply.code(403).send(providerBrokerApplicationFailureBody(response, resourceId));
}

function loopbackPort(app: FastifyInstance): number {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Provider broker application server is not listening');
    return address.port;
}

/**
 * Starts the one target-daemon Provider application. Each admitted machine/1
 * stream receives a one-connection first-bytes proxy. The proxy's target TCP
 * port is used as an unforgeable, process-local lookup key for the exact QUIC
 * endpoint and signed binding verified by admission; request headers never
 * supply transport identity.
 */
export async function startProviderBrokerApplicationServer(input: Readonly<{
    handler: ProviderBrokerRequestHandler;
    localConsumer?: Readonly<{
        authorize(headers: Readonly<Record<string, string>>): boolean;
        request(request: ManagedServiceRequest): ReturnType<ProviderBrokerRequestHandler>;
    }>;
}>): Promise<StartedProviderBrokerApplicationServer> {
    const contextsByRemotePort = new Map<number, ProviderBrokerAuthenticatedStreamContext>();
    const proxies = new Set<FirstBytesLocalCapabilityProxy>();
    const streamLifetimes = new Set<Pick<ProviderBrokerApplicationStreamLifetime, 'close' | 'retire'>>();
    const app = fastify({ logger: false });
    app.addHook('onError', async (_request, _reply, error) => {
        const errorCode = typeof error.code === 'string' && (
            Object.hasOwn(constants.errno, error.code)
            || Object.hasOwn(errorCodes, error.code)
            || Object.getOwnPropertyDescriptor(AxiosError, error.code)?.value === error.code
        ) ? error.code : undefined;
        logger.warnLocalFile('[provider-broker-application]', {
            stage: 'handler', code: 'exception',
            errorName: APPLICATION_ERROR_NAMES.has(error.name) ? error.name : 'UnknownError',
            ...(errorCode ? { errorCode } : {}),
        });
    });
    app.setErrorHandler((error, _request, reply) => {
        // Preserve Fastify's parser/size refusals. Unexpected application
        // failures use the same closed refusal as other broker unavailability,
        // so neither its default 500 body nor Provider exception text escapes.
        if (error.statusCode && error.statusCode < 500 && Object.hasOwn(errorCodes, error.code)) return reply.send(error);
        return writeProviderBrokerApplicationFailure(reply, { ok: false, reasonCode: 'broker_unavailable' });
    });

    const sendResponse = async (
        reply: FastifyReply,
        response: Awaited<ReturnType<ProviderBrokerRequestHandler>>,
        requestSignal: AbortSignal,
        context?: ProviderBrokerAuthenticatedStreamContext,
    ) => {
        if (!response.ok) {
            logger.warnLocalFile('[provider-broker-application]', { stage: 'application_response', code: response.reasonCode });
            return writeProviderBrokerApplicationFailure(
                reply,
                response,
                // Only the private stream has a recipient Session to attribute
                // the refusal to; the external carrier answers an API key.
                context && context.kind !== 'external' && context.kind !== 'account_connection' ? context.expected.resourceId : undefined,
            );
        }
        for (const [name, value] of Object.entries(response.response.headers)) {
            if (!RESPONSE_HOP_BY_HOP_HEADERS.has(name.toLowerCase())) reply.header(name, value);
        }
        reply.code(response.response.status);
        if (!response.response.body) return reply.send();
        const responseBody = response.response.body;
        const reader = responseBody.getReader();
        let cancellationRequested = false;
        const cancelBody = (): void => {
            if (cancellationRequested) return;
            cancellationRequested = true;
            void reader.cancel().catch(() => undefined);
        };
        reply.raw.once('close', cancelBody);
        requestSignal.addEventListener('abort', cancelBody, { once: true });
        return reply.send(Readable.from((async function* () {
            let completed = false;
            try {
                while (true) {
                    const next = await reader.read();
                    if (next.done) {
                        completed = true;
                        return;
                    }
                    yield Buffer.from(next.value);
                }
            } finally {
                reply.raw.off('close', cancelBody);
                requestSignal.removeEventListener('abort', cancelBody);
                if (!completed) await reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
        })()));
    };

    app.post(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1, {
        bodyLimit: TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_ENVELOPE_MAX_BYTES_V1,
    }, async (request, reply) => {
        const remotePort = request.raw.socket.remotePort;
        const context = remotePort === undefined ? undefined : contextsByRemotePort.get(remotePort);
        if (!context || context.kind !== 'external') return reply.code(403).send();
        const parsed = TeamCredentialProviderBrokerApplicationCarrierRequestV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send();
        const controller = new AbortController();
        request.raw.once('aborted', () => controller.abort());
        reply.raw.once('close', () => controller.abort());
        const result = await input.handler({
            context,
            carrierRequest: parsed.data,
            request: {
                pathAndQuery: parsed.data.pathAndQuery,
                method: parsed.data.method,
                headers: parsed.data.headers,
                ...(parsed.data.bodyBase64 ? { body: decodeBase64(parsed.data.bodyBase64, 'base64') } : {}),
                signal: controller.signal,
            },
        });
        return await sendResponse(reply, result, controller.signal);
    });

    app.register(async (inference) => {
        // Keep the one ingress buffer. The request policy owns JSON parsing;
        // parsing here would serialize a second copy before that evaluation.
        inference.removeAllContentTypeParsers();
        inference.addContentTypeParser(['application/json', 'text/plain'], {
            parseAs: 'buffer',
            bodyLimit: Number.MAX_SAFE_INTEGER,
        }, (_request, body, done) => done(null, body));
        inference.route<{ Body: Uint8Array }>({
            method: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
            url: '/v1/*',
            // Fastify requires a positive integer. Its maximum representable byte
            // count disables the default application cap; transport frames bound
            // their own chunks, not the total inference request.
            bodyLimit: Number.MAX_SAFE_INTEGER,
            handler: async (request, reply) => {
                const remotePort = request.raw.socket.remotePort;
                const context = remotePort === undefined ? undefined : contextsByRemotePort.get(remotePort);
                const headers: Record<string, string> = {};
                for (const [name, value] of Object.entries(request.headers)) {
                    if (typeof value === 'string') headers[name] = value;
                }
                const localConsumer = !context ? input.localConsumer : undefined;
                if (localConsumer ? !localConsumer.authorize(headers) : !context || context.kind === 'external') {
                    return reply.code(403).send();
                }
                // The Agent's bearer is its local capability, meaningful only to
                // the tunnel; authority comes from the stream's admission.
                delete headers.authorization;
                // Native HTTP adds Host, Connection and framing headers. They are
                // transport facts, not public Provider headers; managed access
                // correctly rejects them. Project once at this shared ingress,
                // after authenticating the original local capability headers.
                const publicHeaders = Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
                    const parsed = ProviderPublicHeadersV1Schema.safeParse({ [name]: value });
                    return parsed.success ? Object.entries(parsed.data) : [];
                }));
                const body = request.body;
                const controller = new AbortController();
                request.raw.once('aborted', () => controller.abort());
                reply.raw.once('close', () => controller.abort());
                const forwardedRequest: ManagedServiceRequest = {
                    pathAndQuery: request.raw.url ?? request.url,
                    method: request.method as ManagedServiceRequest['method'],
                    headers: publicHeaders,
                    ...(body ? { body } : {}),
                    signal: controller.signal,
                };
                const result = localConsumer
                    ? await localConsumer.request(forwardedRequest)
                    : await input.handler({ context, request: forwardedRequest });
                return await sendResponse(reply, result, controller.signal, context);
            },
        });
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const createStreamTarget = async (
        context: ProviderBrokerAuthenticatedStreamContext,
        admissionSignal?: AbortSignal,
    ): Promise<ProviderBrokerApplicationStreamTarget> => {
        // Admission owns an unclaimed target. Once the one-shot capability is
        // accepted, the authenticated stream and proxy-close path own it.
        admissionSignal?.throwIfAborted();
        let registeredPort: number | null = null;
        const proxy = await startFirstBytesLocalCapabilityProxy({
            targetPort: loopbackPort(app),
            ...(admissionSignal ? { abortSignalUntilClaimed: admissionSignal } : {}),
            onTargetConnected: ({ localPort }) => {
                registeredPort = localPort;
                contextsByRemotePort.set(localPort, context);
            },
        });
        proxies.add(proxy);
        const streamLifetime = 'streamLifetime' in context
            ? context.streamLifetime
            : undefined;
        if (streamLifetime) streamLifetimes.add(streamLifetime);
        void proxy.closed.finally(async () => {
            proxies.delete(proxy);
            if (registeredPort !== null) contextsByRemotePort.delete(registeredPort);
            if (streamLifetime) {
                const released = await streamLifetime.close().then(
                    () => true,
                    () => false,
                );
                if (released) streamLifetimes.delete(streamLifetime);
            }
        });
        if (admissionSignal?.aborted) {
            await proxy.close();
            await streamLifetime?.close().catch(() => undefined);
            admissionSignal.throwIfAborted();
        }
        return { port: proxy.port, localCapability: proxy.localCapability };
    };
    return Object.freeze({
        app,
        ...(input.localConsumer ? { localConsumerEndpointUrl: `http://127.0.0.1:${loopbackPort(app)}` } : {}),
        createStreamTarget,
        close: async () => {
            await Promise.all([...proxies].map(async (proxy) => await proxy.close()));
            await Promise.all([...streamLifetimes].map(async (lifetime) => await lifetime.close()));
            streamLifetimes.clear();
            contextsByRemotePort.clear();
            await app.close();
        },
    });
}
