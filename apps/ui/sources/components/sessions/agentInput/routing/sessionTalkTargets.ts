import * as React from 'react';
import type { ActionSessionAddress } from '@happier-dev/protocol/actions/executor/types';
import type { SessionTargetSelectorV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import { PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import { createDefaultActionExecutor, type UiSessionTargetPreview } from '@/sync/ops/actions/defaultActionExecutor';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { t } from '@/text';

export type SessionTalkSelector = Exclude<SessionTargetSelectorV1['selector'], 'self'>;
export type SessionTalkTargetPreview = Readonly<{
    target: SessionTargetSelectorV1 | null;
    coverage: 'complete' | 'partial' | 'unavailable';
    addresses: readonly ActionSessionAddress[];
    names: readonly string[];
    loading: boolean;
    error: string | null;
}>;
export type SessionTalkTargetOptions = Readonly<{
    /** The picker/open-intent owner supplies demand; closed controls do no work. */
    enabled?: boolean;
    matchingFilter?: SessionListFilterV1;
    discussionId?: string;
}>;
type PreviewState = Omit<SessionTalkTargetPreview, 'target' | 'names'>;
type SelectorPreviews = Readonly<Record<SessionTalkSelector, PreviewState>>;
export type SessionTalkTargets = Readonly<Record<SessionTalkSelector, SessionTalkTargetPreview>> & Readonly<{ refresh: () => void }>;

const SELECTORS = ['manager', 'workers', 'siblings', 'followers', 'following', 'matching', 'discussion'] as const;
const EMPTY_ADDRESSES: readonly ActionSessionAddress[] = [];
const UNAVAILABLE: PreviewState = { coverage: 'unavailable', addresses: EMPTY_ADDRESSES, loading: false, error: null };
function mapSelectorPreviews<T>(read: (selector: SessionTalkSelector) => T): Readonly<Record<SessionTalkSelector, T>> {
    return { manager: read('manager'), workers: read('workers'), siblings: read('siblings'),
        followers: read('followers'), following: read('following'), matching: read('matching'), discussion: read('discussion') };
}
function initialPreviews(): SelectorPreviews {
    return mapSelectorPreviews(() => UNAVAILABLE);
}

/**
 * Preview the same authorized selectors as Action admission. Addressing never depends on loaded rows;
 * local title projections only decorate the already-resolved addresses. Partial results are retained
 * last-known previews, never a sendable subset. Final submission still prepares the original selector.
 */
export function useSessionTalkTargets(sessionId: string, serverId: string | null, options: SessionTalkTargetOptions = {}): SessionTalkTargets {
    const enabled = options.enabled !== false;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(enabled ? serverId : null);
    const targetKey = JSON.stringify([sessionId, options.matchingFilter ?? null, options.discussionId ?? null]);
    const targets = React.useMemo((): Readonly<Record<SessionTalkSelector, SessionTargetSelectorV1 | null>> => {
        const [of, matchingFilter, discussionId] = JSON.parse(targetKey) as [string, SessionListFilterV1 | null, string | null];
        return { manager: { selector: 'manager', of }, workers: { selector: 'workers', of }, siblings: { selector: 'siblings', of },
            followers: { selector: 'followers', of }, following: { selector: 'following', of },
            matching: matchingFilter ? { selector: 'matching', of, filter: matchingFilter } : null,
            discussion: discussionId ? { selector: 'discussion', of, discussionId } : null };
    }, [targetKey]);
    const key = JSON.stringify([serverId, binding?.accountId, binding?.revision, targetKey]);
    const [state, setState] = React.useState<{ key: string; previews: SelectorPreviews }>({ key: '', previews: initialPreviews() });
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!enabled || !binding?.isCurrent()) return;
        return subscribeHomeAccountChange(event => {
            if (!binding.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, binding.serverId)) return;
            // Focused transcript-only wakes explicitly prove that membership did not change.
            // Unqualified concurrent-Home/reconnect wakes retain the owner's conservative semantics.
            if (event.changeKinds?.every(kind => kind === 'session') && event.sessionListQueryAffects === false) return;
            if (event.changeKinds && !event.changeKinds.some(kind => kind === 'session' || kind === 'share'
                || kind === 'discussion' || kind === 'account' || kind === 'kv')) return;
            if (event.changeKinds?.every(kind => kind === 'account') && event.entityIds
                && !event.entityIds.some(id => id === ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID || id === 'self'
                    || id.startsWith(PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1))) return;
            refresh();
        });
    }, [enabled, binding]);
    React.useEffect(() => {
        if (!enabled || !binding?.isCurrent()) return;
        const abort = new AbortController();
        const isCurrent = () => !abort.signal.aborted && binding.isCurrent();
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState({ key, previews: initialPreviews() });
        });
        setState(current => ({ key, previews: mapSelectorPreviews<PreviewState>(selector =>
            targets[selector] ? { ...(current.key === key ? current.previews[selector] : UNAVAILABLE),
                loading: true, error: null } : { ...UNAVAILABLE, error: 'selection_required' },
        ) }));
        const executor = createDefaultActionExecutor();
        for (const selector of SELECTORS) {
            const target = targets[selector];
            if (!target) continue;
            const publish = (result: UiSessionTargetPreview) => {
                if (!isCurrent()) return;
                setState(current => {
                    const previous = current.key === key ? current.previews[selector] : UNAVAILABLE;
                    return { key, previews: { ...current.previews, [selector]: result.coverage === 'complete'
                        ? { ...result, loading: false }
                        : { coverage: previous.addresses.length ? 'partial' : 'unavailable', addresses: previous.addresses,
                            loading: false, error: result.error } } };
                });
            };
            void executor.previewSessionTargets(target, { surface: 'ui', serverId: binding.serverId,
                defaultSessionId: sessionId, expectedAccountId: binding.accountId, signal: abort.signal })
                .then(publish).catch(() => publish({ coverage: 'unavailable', addresses: [], error: 'session_target_unavailable' }));
        }
        return () => { abort.abort(); retirement.dispose(); };
    }, [enabled, binding, key, targets, sessionId, revision]);
    const visible = enabled && binding?.isCurrent() && state.key === key ? state.previews : null;
    const addresses = SELECTORS.flatMap(selector => visible?.[selector].addresses ?? EMPTY_ADDRESSES);
    const titles = useSessionDisplayTitles(addresses);
    let offset = 0;
    return { ...mapSelectorPreviews<SessionTalkTargetPreview>(selector => {
        const preview = visible?.[selector] ?? { ...UNAVAILABLE,
            loading: enabled && Boolean(targets[selector]) && (resolution.kind === 'resolving' || Boolean(binding?.isCurrent())),
            error: !targets[selector] ? 'selection_required'
                : enabled && resolution.kind !== 'resolving' && !binding?.isCurrent() ? 'session_target_unavailable' : null };
        const names = preview.addresses.map(() => titles[offset++] ?? t('session.untitled'));
        return { ...preview, names, target: targets[selector] };
    }), refresh };
}
