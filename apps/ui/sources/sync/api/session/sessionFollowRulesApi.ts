import {
    SESSION_FOLLOW_RULES_ROUTE_V1,
    ListSessionFollowRulesResponseV1Schema,
} from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { openSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import type { OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/actions';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { SESSION_FOLLOW_HTTP_PATHS_V1, SessionAutoFollowPreferencesResponseSchema } from '@happier-dev/protocol/sessions/follow/api';
import type { SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';

export type OpenedSessionFollowRule = OpenedSessionFollowRuleV1;
export type SessionFollowRulesSnapshot = Readonly<{ status: 'ready'; accountId?: string; rules: readonly OpenedSessionFollowRule[];
    defaultPreferences?: SessionAutoFollowPreferencesV1 }>
    | Readonly<{ status: 'unavailable'; reason: string }>;

/** Complete private census: an unreadable neighbor cannot become an empty rule set. */
export async function readSessionFollowRuleCensus(params: Readonly<{
    mode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
    request(path: string, init?: RequestInit): Promise<Response>;
    assertCurrent(): void;
    signal?: AbortSignal;
}>): Promise<readonly OpenedSessionFollowRule[]> {
    params.assertCurrent();
    const response = await params.request(SESSION_FOLLOW_RULES_ROUTE_V1, { method: 'GET', signal: params.signal });
    params.assertCurrent();
    if (!response.ok) throw new Error(response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
        : response.status === 404 ? 'unsupported' : 'unreachable');
    const value = ListSessionFollowRulesResponseV1Schema.parse(await response.json());
    params.assertCurrent();
    return value.rules.map(({ content, ...rule }) => {
        const opened = openSessionFollowRuleContentV1({ ...rule, content, mode: params.mode, material: params.material });
        if (opened.status !== 'opened') throw new Error(opened.reason);
        return { ...rule, definition: opened.definition };
    });
}

/** The ordinary captured Action context owns credentials, mode and retirement. */
export async function readSessionFollowRules(serverId: string, signal?: AbortSignal): Promise<SessionFollowRulesSnapshot> {
    try {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const context = await captureLazyActionAccountContext(serverId, signal);
        try {
            const { encryption } = await context.resolveAccountEncryption();
            const account = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request, usage: 'identity' });
            context.assertCurrent();
            const [rules, defaultsResponse] = await Promise.all([readSessionFollowRuleCensus({
                mode: account.mode,
                material: account.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials),
                request: context.request, assertCurrent: context.assertCurrent, signal,
            }), context.request(SESSION_FOLLOW_HTTP_PATHS_V1.preferences, { method: 'GET', signal })]);
            context.assertCurrent();
            if (!defaultsResponse.ok) throw new Error(defaultsResponse.status === 401 ? 'unauthorized'
                : defaultsResponse.status === 403 ? 'forbidden' : defaultsResponse.status === 404 ? 'unsupported' : 'unreachable');
            const defaultPreferences = SessionAutoFollowPreferencesResponseSchema.parse(await defaultsResponse.json());
            context.assertCurrent();
            const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request, usage: 'fresh-authority' });
            context.assertCurrent();
            if (current.mode !== account.mode) return { status: 'unavailable', reason: 'account-mode-mismatch' };
            return { status: 'ready', accountId: context.accountId, rules, defaultPreferences };
        } finally { context.dispose(); }
    } catch (error) {
        return { status: 'unavailable', reason: classifyAccountStorageReadFailure(error, signal) };
    }
}
