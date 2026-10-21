import { randomUUID } from 'node:crypto';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import { PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, type PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import { decodePeerTcpTunnelBinaryFrameV2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v2';
import { type AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1, TeamCredentialProviderBrokerApplicationCarrierRequestV1Schema, TeamCredentialExternalProviderApplicationRequestV1Schema, TeamCredentialResourceTestApplicationRequestV1Schema, type TeamCredentialResourceTestApplicationRequestV1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { TeamCredentialUsageLimitDenialV1Schema } from '@happier-dev/protocol/teams';
import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerRelayApplicationBindingV1 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/authorizationSchemas';

import { readMachineTunnelFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { resolvePeerMediationGrantSigningConfig } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';
import { mintProviderBrokerRelayAuthorizationV2 } from '@/app/machines/peer/mediation/tunnel';
import {
    createPeerTcpTunnelRelaySubstream,
    type PeerTcpTunnelRelayTransportFactory,
} from '@/app/machines/peer/mediation/tunnel/peerRelayStreamTransport';
import type { ExternalProviderBrokerDispatch } from './registerExternalProviderApiRoutes';
import { inTx } from '@/storage/inTx';
import { admitTeamCredentialBrokerMachineForResourceInTx } from '@/app/teams/credentials/brokerPlacementResolver';
import { authorizeTeamCredentialResourceTestActorInTx } from '@/app/teams/credentials/resourceTest';
import { logger } from '@/utils/logging/log';

function send(transport: ReturnType<PeerTcpTunnelRelayTransportFactory>, envelope: PeerTcpTunnelRelayEnvelope) {
    transport.send(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);
}

type ProviderBrokerCarrierDispatchResult = Awaited<ReturnType<ExternalProviderBrokerDispatch>>
    | Readonly<{ ok: false; error: 'broker_unavailable'; reason: 'incompatible' }>;

type ProviderBrokerCarrierDispatch = (input: Readonly<{
    request: unknown;
    binding: ProviderBrokerRelayApplicationBindingV1;
    target: Readonly<{ custodianAccountId: string; brokerMachineId: string }>;
    signal: AbortSignal;
}>) => Promise<ProviderBrokerCarrierDispatchResult>;

/** Map only the closed denial detail emitted by the trusted broker application. */
export function mapProviderBrokerApplicationFailure(
    statusCode: number,
    headers: Readonly<Record<string, string>>,
): Readonly<{
    error: 'invalid_request' | 'policy_denied' | 'broker_unavailable' | 'request_cancelled'
        | 'resource_unavailable' | 'team_credential_usage_limit' | 'cost_limit_unavailable' | 'upstream_unavailable';
    retryAtMs?: number;
    reason?: 'incompatible';
}> {
    const code = headers['x-happier-provider-broker-error-code'];
    if (statusCode === 499 && code === 'request_cancelled') return { error: 'request_cancelled' };
    if (statusCode === 403 && code === 'team_credential_usage_limit') {
        const detail = TeamCredentialUsageLimitDenialV1Schema.safeParse({
            metric: headers['x-happier-provider-broker-limit-metric'],
            remaining: headers['x-happier-provider-broker-limit-remaining'],
            resetsAtUtc: headers['x-happier-provider-broker-limit-resets-at'],
        });
        return detail.success
            ? { error: 'team_credential_usage_limit', retryAtMs: Date.parse(detail.data.resetsAtUtc) }
            : { error: 'team_credential_usage_limit' };
    }
    if (statusCode === 403 && code === 'cost_limit_unavailable') return { error: 'cost_limit_unavailable' };
    if (statusCode === 403 && (code === 'resource_changed' || code === 'resource_unavailable'
        || code === 'operation_not_current' || code === 'session_not_active')) return { error: 'resource_unavailable' };
    if (statusCode === 403 && code === 'update_required') return { error: 'broker_unavailable', reason: 'incompatible' };
    if (statusCode === 403 && code === 'broker_unavailable') return { error: 'broker_unavailable' };
    if (statusCode === 400) return { error: 'invalid_request' };
    if (statusCode === 403) return { error: 'policy_denied' };
    return { error: 'upstream_unavailable' };
}

export type TeamCredentialResourceTestBrokerDispatch = (input: Readonly<{
    actorAccountId: string;
    resourceId: string;
    expectedResourceRevision: number;
    brokerMachineId: string;
    application: ProviderBrokerApplicationBindingV1;
    source: TeamCredentialSourceBindingV1;
    verifiedCredentialEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    request: TeamCredentialResourceTestApplicationRequestV1;
    signal: AbortSignal;
}>) => Promise<ProviderBrokerCarrierDispatchResult>;

/**
 * `enabled` is asked on every dispatch: the relay's feature decision reads the Home-effective
 * configuration at the time of the request, not the configuration the process started with.
 */
type ProviderBrokerRelayEnabled = () => boolean | Promise<boolean>;

function createProviderBrokerCarrierDispatch(input: Readonly<{
    env: NodeJS.ProcessEnv;
    createRelayTransport: PeerTcpTunnelRelayTransportFactory;
    enabled: ProviderBrokerRelayEnabled;
}>): ProviderBrokerCarrierDispatch {
    return async ({ request: rawRequest, binding, target, signal }) => {
        const request = TeamCredentialProviderBrokerApplicationCarrierRequestV1Schema.parse(rawRequest);
        const config = readMachineTunnelFeatureEnv(input.env);
        const signing = resolvePeerMediationGrantSigningConfig(input.env);
        const enabled = await input.enabled() === true;
        if (!enabled) {
            logger.warn({ module: 'provider-broker-carrier', stage: 'feature', code: 'disabled' });
            return { ok: false, error: 'broker_unavailable' };
        }
        if (!signing.ok) {
            logger.warn({ module: 'provider-broker-carrier', stage: 'signing', code: signing.reasonCode });
            return { ok: false, error: 'broker_unavailable' };
        }
        const transport = input.createRelayTransport({ accountId: target.custodianAccountId });
        const tunnelId = `provider_broker_${randomUUID()}`;
        const substreamId = `provider_request_${randomUUID()}`;
        const authorization = mintProviderBrokerRelayAuthorizationV2({
            accountId: target.custodianAccountId,
            targetMachineId: target.brokerMachineId,
            relaySocketId: transport.relaySocketId,
            binding,
            tunnelId,
            nowMs: Date.now(),
            ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedTcpTunnel,
            serverGateEnabled: enabled,
            serverCaps: {
                maxFrameBytes: config.serverRoutedMaxFrameBytes,
            },
            signingKey: { keyId: signing.keyId, secretKey: signing.secretKey },
        });
        if (!authorization.ok) {
            logger.warn({ module: 'provider-broker-carrier', stage: 'relay_authorization', code: authorization.reasonCode });
            transport.close();
            return { ok: false, error: 'broker_unavailable' };
        }
        let relay: ReturnType<typeof createPeerTcpTunnelRelaySubstream> | null = null;
        const unsubscribe = transport.subscribe((envelope) => {
            if (envelope.scopeUserId !== target.custodianAccountId) return;
            if (envelope.recipient.kind !== 'user' || envelope.recipient.socketId !== transport.relaySocketId) return;
            if (envelope.sender.kind !== 'machine' || envelope.sender.machineId !== target.brokerMachineId) return;
            if (envelope.v === 1) {
                if (envelope.frame.kind === 'close' || envelope.frame.kind === 'abort') relay?.closeFromTunnel();
                return;
            }
            const decoded = decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: config.serverRoutedMaxBinaryHeaderBytes,
                maxPayloadBytes: config.serverRoutedMaxRawPayloadBytes,
            });
            if (decoded.ok && decoded.header.tunnelId === tunnelId && decoded.header.substreamId === substreamId) relay?.acceptEnvelope(envelope);
        });
        let cleaned = false;
        function abort() { void relay?.stream.abort('request_cancelled'); }
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            signal.removeEventListener('abort', abort);
            unsubscribe();
            transport.close();
        };
        relay = createPeerTcpTunnelRelaySubstream({
            tunnelId, substreamId,
            initialWindowBytes: PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
            maxFrameBytes: config.serverRoutedMaxFrameBytes,
            maxDecodedPayloadBytes: config.serverRoutedMaxRawPayloadBytes,
            maxSendChunkBytes: config.serverRoutedMaxRawPayloadBytes,
            sendEncodedBinaryFrame: (frame) => send(transport, {
                v: 2, encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                scopeUserId: target.custodianAccountId,
                sender: { kind: 'user', socketId: transport.relaySocketId },
                recipient: { kind: 'machine', machineId: target.brokerMachineId }, frame,
            }),
            onRelease: cleanup,
        });
        send(transport, {
            v: 1, scopeUserId: target.custodianAccountId,
            sender: { kind: 'user', socketId: transport.relaySocketId },
            recipient: { kind: 'machine', machineId: target.brokerMachineId },
            frame: { v: 1, kind: 'open', open: {
                v: 1, kind: 'open', tunnelId, targetMachineId: target.brokerMachineId,
                routeKind: 'server_relay', relayAuthorization: authorization.relayAuthorization,
                supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            } },
        });
        relay.open();
        const body = JSON.stringify(request);
        const wire = new TextEncoder().encode([
            `POST ${TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1} HTTP/1.1`,
            'Host: provider-broker.internal', 'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body,
        ].join('\r\n'));
        if (signal.aborted) { await relay.stream.abort('request_cancelled'); return { ok: false, error: 'request_cancelled' }; }
        signal.addEventListener('abort', abort, { once: true });
        const written = await relay.stream.write(wire);
        if (!written.ok) {
            logger.warn({ module: 'provider-broker-carrier', stage: 'request_write', code: 'write_failed' });
            cleanup();
            return { ok: false, error: 'broker_unavailable' };
        }
        await relay.stream.endWrite();
        const iterator = relay.stream.read()[Symbol.asyncIterator]();
        let buffered = Buffer.alloc(0);
        let boundary = buffered.indexOf('\r\n\r\n');
        while (boundary < 0) {
            // The header budget bounds the header segment, which is exactly the
            // delimiter-less prefix. A response whose headers and a legal body
            // arrive coalesced in one relay chunk is not an oversized header,
            // so the budget is checked before reading more rather than against
            // whatever the transport happened to coalesce.
            if (buffered.byteLength > config.serverRoutedMaxBinaryHeaderBytes) {
                cleanup();
                return { ok: false, error: 'upstream_unavailable' };
            }
            const next = await iterator.next();
            if (next.done) { cleanup(); return { ok: false, error: 'upstream_unavailable' }; }
            buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
            boundary = buffered.indexOf('\r\n\r\n');
        }
        const headerText = buffered.subarray(0, boundary).toString('latin1');
        const lines = headerText.split('\r\n');
        const status = /^HTTP\/1\.1 (\d{3})/u.exec(lines.shift() ?? '');
        if (!status) { cleanup(); return { ok: false, error: 'upstream_unavailable' }; }
        const statusCode = Number(status[1]);
        const headers: Record<string, string> = {};
        for (const line of lines) { const split = line.indexOf(':'); if (split > 0) headers[line.slice(0, split).toLowerCase()] = line.slice(split + 1).trim(); }
        if (statusCode >= 400) {
            await relay.stream.close();
            if (statusCode === 403 && (headers['x-happier-provider-broker-error-code'] === 'broker_unavailable'
                || headers['x-happier-provider-broker-error-code'] === 'update_required')) {
                logger.warn({ module: 'provider-broker-carrier', stage: 'application_response',
                    code: headers['x-happier-provider-broker-error-code'] });
            }
            return { ok: false, ...mapProviderBrokerApplicationFailure(statusCode, headers) };
        }
        const initial = buffered.subarray(boundary + 4);
        async function* responseBody() {
            try {
                if (headers['transfer-encoding']?.toLowerCase() !== 'chunked') {
                    if (initial.byteLength > 0) yield new Uint8Array(initial);
                    while (true) { const next = await iterator.next(); if (next.done) return; yield next.value; }
                }
                let pending = initial;
                while (true) {
                    while (pending.indexOf('\r\n') < 0) {
                        const next = await iterator.next();
                        if (next.done) throw new Error('truncated chunk header');
                        pending = Buffer.concat([pending, Buffer.from(next.value)]);
                    }
                    const lineEnd = pending.indexOf('\r\n');
                    const sizeText = pending.subarray(0, lineEnd).toString('ascii').split(';', 1)[0];
                    const size = Number.parseInt(sizeText ?? '', 16);
                    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid chunk header');
                    pending = pending.subarray(lineEnd + 2);
                    if (size === 0) return;
                    while (pending.byteLength < size + 2) {
                        const next = await iterator.next();
                        if (next.done) throw new Error('truncated chunk');
                        pending = Buffer.concat([pending, Buffer.from(next.value)]);
                    }
                    if (pending.subarray(size, size + 2).toString('ascii') !== '\r\n') throw new Error('invalid chunk terminator');
                    yield new Uint8Array(pending.subarray(0, size));
                    pending = pending.subarray(size + 2);
                }
            } finally {
                cleanup();
            }
        }
        return { ok: true, statusCode, headers, body: responseBody() };
    };
}

export function createExternalProviderBrokerDispatcher(input: Readonly<{
    env: NodeJS.ProcessEnv;
    createRelayTransport: PeerTcpTunnelRelayTransportFactory;
    enabled: ProviderBrokerRelayEnabled;
}>): ExternalProviderBrokerDispatch {
    const dispatch = createProviderBrokerCarrierDispatch(input);
    return async ({ request: rawRequest, target, signal }) => {
        const request = TeamCredentialExternalProviderApplicationRequestV1Schema.parse(rawRequest);
        return await dispatch({
            request,
            target,
            signal,
            binding: {
                v: 1,
                kind: 'external_api_key',
                teamId: request.teamId,
                resourceId: request.resourceId,
                requestId: request.requestId,
                externalApiKeyId: request.caller.keyId,
                operationId: target.operationId,
                brokerPlacementFingerprint: target.brokerPlacementFingerprint,
                assignedAccountId: request.caller.assignedAccountId,
                assignedTeamMembershipId: request.caller.assignedTeamMembershipId,
            },
        });
    };
}

export function createTeamCredentialResourceTestBrokerDispatcher(input: Readonly<{
    env: NodeJS.ProcessEnv;
    createRelayTransport: PeerTcpTunnelRelayTransportFactory;
    enabled: ProviderBrokerRelayEnabled;
}>): TeamCredentialResourceTestBrokerDispatch {
    const dispatch = createProviderBrokerCarrierDispatch(input);
    return async ({ actorAccountId, resourceId, expectedResourceRevision, brokerMachineId, application, source, verifiedCredentialEvidence, request: rawRequest, signal }) => {
        const request = TeamCredentialResourceTestApplicationRequestV1Schema.safeParse(rawRequest);
        if (!request.success
            || request.data.resourceId !== resourceId
            || request.data.requestId.trim().length === 0) return { ok: false, error: 'invalid_request' };
        const target = await inTx(async (tx) => {
            const resource = await tx.teamCredentialResource.findUnique({
                where: { id: resourceId },
                select: { id: true, teamId: true, custodianAccountId: true, brokerMachineId: true, brokerPoolId: true, revision: true },
            });
            if (!resource || resource.revision !== expectedResourceRevision
                || request.data.teamId !== resource.teamId) return null;
            const actorAuthorization = await authorizeTeamCredentialResourceTestActorInTx(tx, {
                teamId: resource.teamId,
                custodianAccountId: resource.custodianAccountId,
                actorAccountId,
                authentication: {
                    authenticationAuthority: 'account_automation',
                    authenticationEvidence: verifiedCredentialEvidence,
                },
            });
            if (!actorAuthorization.ok) return null;
            const broker = await admitTeamCredentialBrokerMachineForResourceInTx(tx, { resource, brokerMachineId });
            if (!broker.ok) return null;
            return {
                teamId: resource.teamId,
                custodianAccountId: resource.custodianAccountId,
                brokerMachineId,
                verifiedCredentialEvidence: actorAuthorization.verifiedCredentialEvidence,
            };
        });
        if (!target) return { ok: false, error: 'policy_denied' };
        return await dispatch({
            request: request.data,
            target,
            signal,
            binding: {
                v: 1,
                kind: 'resource_test',
                teamId: target.teamId,
                resourceId,
                requestId: request.data.requestId,
                actorAccountId,
                expectedResourceRevision,
                application,
                source,
                ...(target.verifiedCredentialEvidence && target.verifiedCredentialEvidence.length > 0
                    ? { verifiedCredentialEvidence: { v: 1 as const, evidence: [...target.verifiedCredentialEvidence] } }
                    : {}),
            },
        });
    };
}
