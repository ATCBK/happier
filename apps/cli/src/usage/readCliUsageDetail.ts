import { fetchSessionMessagesPage } from '@happier-dev/sync-client';
import { MetadataSchema, AgentStateSchema } from '@happier-dev/session-core/state';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { readStoredSessionMessageDeliveryResolutionV1, SessionMessageAcceptedDeliveryFactsV1StoredSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { projectUsageQueryWorkEvidence, selectUsageQueryWorkEvidenceSessionIds, usageQueryNeedsSessionCandidates, type OpenedUsageMessage, type OpenedUsageSession } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { collectUsageWorkSources } from '@happier-dev/protocol/usage/usageWorkSources';
import type { UsageCoachRemedySession } from '@happier-dev/protocol/usage/coach/buildUsageCoachRemedies';
import { getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageAccountingSourceSnapshot } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { StoredCredentials } from '@/persistence';
import { fetchSessionById, fetchSessionsPage, fetchSessionTurnsProjection } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveExactSessionOrCredentialCryptoContext, tryDecryptSessionOwnerMetadataView, openSessionMessageContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionAgentState } from '@/session/actions/cliActionDeps/sessionStateReaders';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';

/** Protected transport adapter; deterministic membership, phases and SCM joins are shared. */
export async function readCliUsageDetail(input: Readonly<{
    queries: readonly UsageQuery[];
    accounting: readonly UsageAccountingSourceSnapshot[];
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    accountEncryptionMode: 'plain' | 'e2ee' | null;
    allowPrivateRead: boolean;
    nowMs: number;
    signal?: AbortSignal;
    assertCurrent: () => Promise<void>;
    resolveHeaders: (request: Readonly<{ method: 'GET'; path: string }>) => Readonly<Record<string, string>> | null;
    read: (path: string) => Promise<unknown>;
}>) {
    const accounting = new Map(input.accounting.map(row => [getUsageQueryKey(row.query), row.value?.contributions]));
    const admitted = input.allowPrivateRead && input.accountEncryptionMode !== null;
    const evidenceQueries = input.queries.filter(query => query.includeSessionEvidence);
    const candidates: { id: string }[] = [];
    if (admitted && evidenceQueries.some(usageQueryNeedsSessionCandidates)) {
        await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
            try {
                for (const archivedOnly of [false, true]) {
                    let cursor: string | undefined;
                    do {
                        await input.assertCurrent();
                        const page = await fetchSessionsPage({ token: input.credentials.token, archivedOnly, cursor,
                            resolveAuthorizationHeaders: input.resolveHeaders, signal: input.signal });
                        await input.assertCurrent();
                        candidates.push(...page.sessions.map(session => ({ id: session.id })));
                        cursor = page.hasNext && page.nextCursor !== null ? page.nextCursor : undefined;
                    } while (cursor !== undefined);
                }
            } catch { await input.assertCurrent(); candidates.length = 0; }
        });
    }
    const idsByQuery = new Map(evidenceQueries.map(query => [getUsageQueryKey(query), selectUsageQueryWorkEvidenceSessionIds({
        query, sessions: candidates, contributions: accounting.get(getUsageQueryKey(query)),
    })]));
    const intervalSessionIds = new Set([...idsByQuery.values()].flat());
    const transcriptSessionIds = new Set(evidenceQueries.filter(query => query.includeTranscriptEvidence)
        .flatMap(query => idsByQuery.get(getUsageQueryKey(query)) ?? []));
    const workQueries = input.queries.filter(query => query.includeWorkEvidence);
    const workSessionIds = workQueries.flatMap(query => accounting.get(getUsageQueryKey(query))
        ?.flatMap(row => row.sessionId !== null && row.turnId !== null ? [row.sessionId] : []) ?? []);
    type Detail = Readonly<{ session: OpenedUsageSession; remedySession: UsageCoachRemedySession;
        messages?: readonly OpenedUsageMessage[]; messagesComplete: boolean;
        machineId: string | null; cwd: string | null; canReadWork: boolean }>;
    const sessions = new Map<string, Detail>();
    await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
        await Promise.all([...new Set([...intervalSessionIds, ...workSessionIds])].map(async sessionId => {
            if (!admitted) return;
            try {
                await input.assertCurrent();
                const rawSession = await fetchSessionById({ token: input.credentials.token, sessionId,
                    serverUrl: input.serverHttpBaseUrl, resolveAuthorizationHeaders: input.resolveHeaders, signal: input.signal });
                await input.assertCurrent();
                if (!rawSession || rawSession.id !== sessionId) return;
                const role = readSessionAccessProjectionRoleV1(rawSession);
                if (role === 'unavailable' || rawSession.effectiveAccess?.capabilities.readTranscript === false) return;
                const crypto = resolveExactSessionOrCredentialCryptoContext({ credentials: input.credentials }, sessionId, rawSession);
                if (!crypto) return;
                const ownerMetadata = tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
                    accountEncryptionMode: input.accountEncryptionMode!, rawSession });
                // Owner metadata cannot be substituted with a raw public projection.
                const parsedMetadata = MetadataSchema.safeParse(ownerMetadata);
                const metadata = parsedMetadata.success ? parsedMetadata.data : null;
                if (role === 'owner' && !metadata) return;
                const agentState = AgentStateSchema.safeParse(intervalSessionIds.has(sessionId)
                    ? readSessionAgentState({ rawSession, ...crypto }) : null);
                const sessionTurns = intervalSessionIds.has(sessionId) ? await fetchSessionTurnsProjection({ token: input.credentials.token, sessionId,
                    resolveAuthorizationHeaders: input.resolveHeaders, signal: input.signal }) : null;
                await input.assertCurrent();
                let messages: OpenedUsageMessage[] | undefined;
                let messagesComplete = false;
                if (transcriptSessionIds.has(sessionId)) try {
                    const page = await fetchSessionMessagesPage({ sessionId, scope: 'all', roles: ['user', 'agent', 'event'],
                        requestJson: path => input.read(path), signal: input.signal });
                    await input.assertCurrent();
                    const opened = page.messages.flatMap(message => {
                            const content = openSessionMessageContent({ ...crypto, content: message.content });
                            const resolution = readStoredSessionMessageDeliveryResolutionV1(message.deliveryResolution);
                            const accepted = resolution?.kind === 'provider_accepted'
                                ? SessionMessageAcceptedDeliveryFactsV1StoredSchema.safeParse(openSessionMessageContent({ ...crypto, content: resolution.content })) : null;
                            return [{ id: message.id, localId: message.localId, content, createdAt: message.createdAt,
                                ...(accepted?.success ? { acceptedDelivery: accepted.data } : {}) }];
                    });
                    if (page.messages.length === 0 || opened.length > 0) messages = opened;
                    messagesComplete = page.hasMore === false && opened.length === page.messages.length;
                } catch (error) {
                    await input.assertCurrent();
                    // Failed access/format admission cannot revive any Session private facts.
                    const { kind } = classifyServerEndpointError(error);
                    if (!['network', 'timeout', 'server_error', 'dependency_unavailable', 'rate_limited'].includes(kind)) return;
                }
                const access = rawSession.effectiveAccess ?? (role === 'owner' ? { capabilities: { submitAgentInput: true } } : undefined);
                const machineId = typeof ownerMetadata?.machineId === 'string' ? ownerMetadata.machineId : null;
                const cwd = typeof ownerMetadata?.path === 'string' ? ownerMetadata.path : null;
                sessions.set(sessionId, { session: { id: sessionId, metadata, agentState: agentState.success ? agentState.data : null, sessionTurns },
                    remedySession: { id: sessionId, serverId: input.serverId, active: rawSession.active, access,
                        ownerMetadata, agentTarget: readAcpConfiguredBackendV1FromMetadata(ownerMetadata)?.backendId ? null
                            : resolveAgentExecutionTargetFromSessionMetadata(ownerMetadata) },
                    messages, messagesComplete, machineId, cwd,
                    canReadWork: role === 'owner' || rawSession.effectiveAccess?.capabilities.submitAgentInput === true });
            } catch { await input.assertCurrent(); }
        }));
    });
    await input.assertCurrent();
    const work = await collectUsageWorkSources({ queries: workQueries, accounting: input.accounting, assertCurrent: input.assertCurrent,
        readSession: async sessionId => {
            const session = sessions.get(sessionId);
            if (!session?.canReadWork || !session.machineId || !session.cwd) return null;
            return async (method, request) => {
                await input.assertCurrent();
                const response = await callMachineRpc({ credentials: input.credentials, serverUrl: input.serverHttpBaseUrl,
                    machineId: session.machineId!, method, request: { ...request, cwd: session.cwd, outcomeVersion: 1 },
                    authorization: { kind: 'session.write', sessionId }, signal: input.signal });
                await input.assertCurrent();
                return response;
            };
        },
    });
    await input.assertCurrent();
    return { work, sessions: [...sessions.values()].map(row => row.remedySession),
        howYouWork: evidenceQueries.map(query => ({ query, asOfMs: input.nowMs,
            detail: projectUsageQueryWorkEvidence({ query,
                sessions: (idsByQuery.get(getUsageQueryKey(query)) ?? []).flatMap(id => sessions.has(id) ? [sessions.get(id)!.session] : []),
                ...(query.includeTranscriptEvidence ? {
                    openedMessages: new Map([...sessions].flatMap(([id, row]) => row.messages === undefined ? [] : [[id, row.messages]])),
                    completeMessageSessionIds: new Set([...sessions].filter(([, row]) => row.messagesComplete).map(([id]) => id)),
                } : {}),
                contributions: accounting.get(getUsageQueryKey(query)),
            }),
        })),
    };
}
