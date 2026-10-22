import { parseSessionFollowActionResponse, resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SessionFollowErrorCodeV1Schema, type SetSessionFollowRequest, GetSessionFollowResponseSchema, SetSessionFollowResponseSchema, RemoveSessionFollowResponseSchema, SessionAutoFollowPreferencesResponseSchema, ReplaceSessionVoiceInclusionsResponseSchema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { SessionFollowSourcesErrorCodeV1Schema, type SessionFollowSourcesErrorCodeV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { SessionFollowActionIdV1, SessionFollowActionOutputV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { FollowPreviewActionInputV1Schema, FollowRuleSetActionInputV1Schema, SessionFollowActionInputSchemasV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { equalFollowRuleReceiverV1, GetSessionFollowRuleResponseV1Schema, SetSessionFollowRuleResponseV1Schema,
    SessionFollowRuleDefinitionV1Schema, SessionFollowRuleErrorResponseV1Schema,
    type SessionFollowRuleFailureV1,
} from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { openSessionFollowRuleContentV1, sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { ListAccountSessionFollowsResponseV1Schema } from '@happier-dev/protocol/sessions/follow/api';
import { ListSessionFollowSourcesResponseSchema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import type { AccountEncryptionReadUsage } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { readSessionFollowRuleCensus, type SessionFollowRulesSnapshot } from './sessionFollowRulesApi';
import { FollowReceiverRefV1Schema, FollowSourceRefV1Schema, type FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { createServerRequestForResolvedServerScope, runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { resolveServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';

export type SessionFollowApiResult<T> =
    | Readonly<{ kind: 'ok'; value: T }>
    | Readonly<{ kind: 'failed'; error: SessionFollowSourcesErrorCodeV1 | SessionFollowRuleFailureV1 | 'credential_scope_denied' | 'unavailable' }>;

const UNAVAILABLE = Object.freeze({ kind: 'failed', error: 'unavailable' } as const);

type ResolvedFollowRequestContext = Awaited<ReturnType<typeof resolveServerAccountRequestContext>>;
type ScopedFollowRequestContext = Extract<ResolvedFollowRequestContext, { scope: 'scoped' }>;

/**
 * One currentness/credential guard for every exact-Home Follow request. Human
 * controls, Actions, and the Voice inclusion replacement all use this seam so
 * a credential rotation cannot be handled by one path and missed by another.
 */
async function withCurrentFollowRequest<T>(params: Readonly<{
    serverId: string;
    expectedAccountId?: string;
    signal?: AbortSignal;
    operation: (request: Readonly<{
        context: ScopedFollowRequestContext;
        signal: AbortSignal;
        isCurrent: () => boolean;
    }>) => Promise<T>;
}>): Promise<T | typeof UNAVAILABLE> {
    if (!params.serverId.trim() || params.signal?.aborted) return UNAVAILABLE;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent()) return UNAVAILABLE;

    const controller = new AbortController();
    const abort = () => controller.abort();
    const retirement = lifetime.onRetire(abort);
    // An inactive Home can change credentials without retiring the focused Home.
    const unsubscribeCredentials = subscribeHomeCredentialMutations((event) => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, params.serverId)) abort();
    });
    params.signal?.addEventListener('abort', abort, { once: true });
    if (params.signal?.aborted) abort();
    const isCurrent = () => lifetime.isCurrent() && !controller.signal.aborted;
    let context: ResolvedFollowRequestContext | undefined;

    try {
        context = await resolveServerAccountRequestContext({ serverId: params.serverId, preferScoped: true });
        if (!isCurrent() || context.scope !== 'scoped') return UNAVAILABLE;
        if (params.expectedAccountId !== undefined && context.targetAccountId !== params.expectedAccountId) return UNAVAILABLE;
        if (areServerProfileIdentifiersEquivalent(context.targetServerId, lifetime.scope.serverId)
            && context.targetAccountId !== lifetime.scope.accountId) return UNAVAILABLE;
        return await params.operation({ context, signal: controller.signal, isCurrent });
    } catch {
        return UNAVAILABLE;
    } finally {
        retirement.dispose();
        unsubscribeCredentials();
        params.signal?.removeEventListener('abort', abort);
        if (context?.scope === 'scoped') await context.release?.();
    }
}

/** One family adapter for human controls and the shared Action executor. */
export async function executeSessionFollowAction<TActionId extends SessionFollowActionIdV1>(
    actionId: TActionId,
    input: unknown,
    serverId: string,
    signal?: AbortSignal,
    expectedAccountId?: string,
    sourceSessionId?: string,
): Promise<SessionFollowApiResult<SessionFollowActionOutputV1[TActionId]>> {
    return await withCurrentFollowRequest({
        serverId,
        signal,
        ...(expectedAccountId !== undefined ? { expectedAccountId } : {}),
        operation: async ({ context, signal: requestSignal, isCurrent }) => {
            const actionInput = SessionFollowActionInputSchemasV1[actionId].parse(input);
            const send = createServerRequestForResolvedServerScope({
                context,
                // preferScoped must never fall back to the focused Home transport.
                activeRequest: async () => { throw new Error('Follow requires an explicit Home'); },
            });
            const parsedSource = FollowSourceRefV1Schema.safeParse('source' in actionInput ? actionInput.source : undefined);
            const ruleTarget = parsedSource.success && parsedSource.data.kind === 'rule' && 'receiver' in actionInput
                ? { ruleId: parsedSource.data.ruleId, receiver: FollowReceiverRefV1Schema.parse(actionInput.receiver) } : null;
            const readStorage = async (usage: AccountEncryptionReadUsage = 'fresh-authority') => {
                if (!context.credentials) throw new Error('encryption-material-unavailable');
                const account = await resolveAccountStorageContext(context.credentials, { encryption: context.encryption, request: send, usage });
                if (!isCurrent()) throw new Error('scope-retired');
                return { mode: account.mode, material: account.mode === 'plain' ? null
                    : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials) };
            };
            const readRules = async () => {
                const admitted = await readStorage('identity');
                const rules = await readSessionFollowRuleCensus({ ...admitted, request: send, signal: requestSignal,
                    assertCurrent: () => { if (!isCurrent()) throw new Error('scope-retired'); } });
                return { mode: admitted.mode, rules };
            };
            if (actionId === 'follow.preview') {
                let rules: SessionFollowRulesSnapshot;
                let census: Awaited<ReturnType<typeof readRules>> | undefined;
                try {
                    census = await readRules();
                    rules = { status: 'ready', accountId: context.targetAccountId, rules: census.rules };
                } catch (error) {
                    if (!isCurrent()) return UNAVAILABLE;
                    rules = { status: 'unavailable', reason: classifyAccountStorageReadFailure(error, requestSignal) };
                }
                const { previewSessionFollowRule } = await import('./sessionFollowRulePreview');
                const sourceSession = sourceSessionId ? (await runWithServerRequestAuthorityForServerAccountScope({
                    scope: { serverId: context.targetServerId, accountId: context.targetAccountId }, activeRequest: send,
                }, authority => readSessionSnapshotForAuthority({ authority, sessionId: sourceSessionId,
                    signal: requestSignal, isCurrent }))).session : undefined;
                const payload = await previewSessionFollowRule({ serverId: context.targetServerId,
                    accountId: context.targetAccountId, request: FollowPreviewActionInputV1Schema.parse(input), rules,
                    ...(sourceSession ? { sourceSession } : {}),
                    signal: requestSignal,
                    assertCurrent: () => { if (!isCurrent()) throw new Error('scope-retired'); },
                });
                if (census) {
                    const current = await readStorage();
                    if (current.mode !== census.mode) return UNAVAILABLE;
                }
                return { kind: 'ok', value: parseSessionFollowActionResponse(actionId, input, payload) };
            }
            const account = ruleTarget && actionId !== 'follow.remove' ? await readStorage() : null;
            const authored = ruleTarget && actionId === 'follow.set' ? FollowRuleSetActionInputV1Schema.parse(input) : null;
            const ruleContent = authored && account && ruleTarget ? sealSessionFollowRuleContentV1({ ruleId: authored.source.ruleId,
                receiver: ruleTarget.receiver, definition: SessionFollowRuleDefinitionV1Schema.parse({ ...authored.ruleDefinition, policy: authored.policy }),
                mode: account.mode, material: account.material }) : undefined;
            const request = resolveSessionFollowActionRequest(actionId, input, { ...(ruleContent ? { ruleContent } : {}) });
            const response = await send(request.path, {
                method: request.method,
                ...(request.body === undefined ? {} : {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(request.body),
                }),
                signal: requestSignal,
            });
            if (!isCurrent()) return UNAVAILABLE;
            const payload: unknown = await response.json();
            if (!isCurrent()) return UNAVAILABLE;
            if (!response.ok) {
                const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, payload);
                if (scopeDenial) return { kind: 'failed', error: scopeDenial.errorCode };
                const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
                if (ruleTarget) {
                    const error = SessionFollowRuleErrorResponseV1Schema.safeParse(payload);
                    return error.success ? { kind: 'failed', error: error.data.error } : UNAVAILABLE;
                }
                const error = SessionFollowSourcesErrorCodeV1Schema.safeParse(record.error);
                return error.success ? { kind: 'failed', error: error.data } : UNAVAILABLE;
            }
            if (ruleTarget && account && (actionId === 'follow.get' || actionId === 'follow.set')) {
                const rule = actionId === 'follow.get' ? GetSessionFollowRuleResponseV1Schema.parse(payload).rule
                    : SetSessionFollowRuleResponseV1Schema.parse(payload).rule;
                if (rule && (rule.ruleId !== ruleTarget.ruleId || !equalFollowRuleReceiverV1(rule.receiver, ruleTarget.receiver))) return UNAVAILABLE;
                const current = await readStorage();
                if (current.mode !== account.mode) return UNAVAILABLE;
                const opened = rule ? openSessionFollowRuleContentV1({ ...rule, mode: current.mode, material: current.material }) : null;
                if (opened && opened.status !== 'opened') return UNAVAILABLE;
                return { kind: 'ok', value: parseSessionFollowActionResponse(actionId, input, {
                    rule: rule && opened?.status === 'opened' ? { ruleId: rule.ruleId, receiver: rule.receiver,
                        version: rule.version, definition: opened.definition } : null,
                }) };
            }
            if (actionId === 'follow.list') {
                const list = SessionFollowActionInputSchemasV1['follow.list'].parse(input);
                if (list.direction === 'followers') return { kind: 'ok', value: parseSessionFollowActionResponse(actionId, input, payload) };
                const receiver = FollowReceiverRefV1Schema.parse(list.receiver);
                const census = list.cursor === undefined ? await readRules() : null;
                if (census) {
                    const current = await readStorage();
                    if (current.mode !== census.mode) return UNAVAILABLE;
                }
                const rows = receiver.kind === 'account'
                    ? { ...ListAccountSessionFollowsResponseV1Schema.parse(payload), sources: [] }
                    : { follows: [], ...ListSessionFollowSourcesResponseSchema.parse(payload) };
                return { kind: 'ok', value: parseSessionFollowActionResponse(actionId, input, { ...rows,
                    rules: census?.rules.filter(rule => equalFollowRuleReceiverV1(rule.receiver, receiver)) ?? [],
                    coverage: rows.continuation ? 'partial' : 'complete',
                }) };
            }
            return { kind: 'ok', value: parseSessionFollowActionResponse(actionId, input, payload) };
        },
    });
}

/** Private receiver scopes for this exact Home/Account; null never means unmuted. */
export async function readAccountSessionDeliveryMutedScopes(
    scope: ServerAccountScope,
    signal?: AbortSignal,
): Promise<readonly FollowDeliveryMuteScopeV1[] | null> {
    if (!scope.accountId.trim()) return null;
    try {
        const result = await executeSessionFollowAction('session.delivery.mute.list', { receiver: { kind: 'account' } },
            scope.serverId, signal, scope.accountId);
        return result.kind === 'ok' ? result.value.scopes : null;
    } catch {
        return null;
    }
}

export const sessionFollowAction = async (args: Parameters<NonNullable<ActionExecutorDeps['sessionFollowAction']>>[0]
    & Readonly<{ sourceSessionId?: string }>) => {
    const result = await executeSessionFollowAction(args.actionId, args.input, args.serverId ?? '', args.signal, undefined, args.sourceSessionId);
    return result.kind === 'ok' ? result.value : {
        ok: false,
        errorCode: result.error === 'unavailable' ? 'network_error' : result.error,
        error: result.error,
    };
};

async function executeAccountFollowAction<TActionId extends SessionFollowActionIdV1, TValue>(
    actionId: TActionId,
    input: unknown,
    serverId: string,
    parse: (value: unknown) => TValue,
) {
    const result = await executeSessionFollowAction(actionId, input, serverId);
    if (result.kind === 'ok') return { kind: 'ok' as const, value: parse(result.value) };
    if (result.error === 'credential_scope_denied') return { kind: 'failed' as const, error: result.error };
    const error = SessionFollowErrorCodeV1Schema.safeParse(result.error);
    return { kind: 'failed' as const, error: error.success ? error.data : 'unavailable' as const };
}

export function sessionFollowGet(address: SessionAddress) {
    return executeAccountFollowAction('follow.get', { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: address.sessionId } }, address.serverId, GetSessionFollowResponseSchema.parse);
}

export function sessionFollowSet(address: SessionAddress, preferences: Pick<SetSessionFollowRequest, 'policy' | 'once'>) {
    return executeAccountFollowAction('follow.set', { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: address.sessionId }, ...preferences }, address.serverId, SetSessionFollowResponseSchema.parse);
}

export function sessionFollowRemove(address: SessionAddress) {
    return executeAccountFollowAction('follow.remove', { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: address.sessionId } }, address.serverId, RemoveSessionFollowResponseSchema.parse);
}

export async function replaceSessionVoiceInclusions(
    serverId: string,
    sessionIds: readonly string[],
): Promise<SessionFollowApiResult<Readonly<{ changed: boolean; sessionIds: string[] }>>> {
    return await withCurrentFollowRequest({
        serverId,
        operation: async ({ context, signal, isCurrent }) => {
            const send = createServerRequestForResolvedServerScope({
                context,
                activeRequest: async () => { throw new Error('Follow requires an explicit Home'); },
            });
            const response = await send(SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionIds: [...sessionIds] }),
                signal,
            });
            if (!isCurrent()) return UNAVAILABLE;
            const payload: unknown = await response.json();
            if (!isCurrent()) return UNAVAILABLE;
            if (!response.ok) {
                const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, payload);
                if (scopeDenial) return { kind: 'failed', error: scopeDenial.errorCode };
                const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
                const error = SessionFollowErrorCodeV1Schema.safeParse(record.error);
                return error.success ? { kind: 'failed', error: error.data } : UNAVAILABLE;
            }
            return { kind: 'ok', value: ReplaceSessionVoiceInclusionsResponseSchema.parse(payload) };
        },
    });
}

export function sessionAutoFollowPreferencesGet(serverId: string) {
    return executeAccountFollowAction('follow.preferences.get', {}, serverId, SessionAutoFollowPreferencesResponseSchema.parse);
}

export function sessionAutoFollowPreferencesSet(serverId: string, preferences: SessionAutoFollowPreferencesV1) {
    return executeAccountFollowAction('follow.preferences.set', preferences, serverId, SessionAutoFollowPreferencesResponseSchema.parse);
}
