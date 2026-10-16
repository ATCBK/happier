import * as React from 'react';

import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveSessionAccessPrincipals } from '@/sync/api/session/sessionAccessApi';

const NO_LABELS: Readonly<Record<string, string | null>> = Object.freeze({});

/**
 * Names the recipients an access manager can see but Lane 04's grant projection cannot.
 *
 * A Session granted to a Team has one grant row and many recipients, so every recipient
 * reachable only through that Team has no principal row to take a name from and the
 * encryption resource deliberately carries none. The existing principal-resolution
 * owner admits discoverable identities (including shared-Team colleagues) together.
 * Omitted or unnamed Accounts keep their identifiers; this does not make them eligible
 * for a new grant or turn the encryption diagnostic into a Team directory.
 */
export function useSessionAccessTeamRecipientLabels(input: Readonly<{
    scope: ServerAccountScope;
    /** The Team grants this Session actually carries; no Team grant, no lookup. */
    teamIds: readonly string[];
    /** Exactly the recipients rendered right now, in the order they are shown. */
    visibleRecipientAccountIds: readonly string[];
    /** Recipients Lane 04 already names; asking about them would be redundant. */
    isAlreadyNamed: (accountId: string) => boolean;
    enabled: boolean;
}>): (accountId: string) => string | undefined {
    const { enabled, isAlreadyNamed } = input;
    const { serverId, accountId } = input.scope;
    const teamKey = JSON.stringify([...input.teamIds].sort());
    const scopeKey = JSON.stringify([serverId, accountId, teamKey]);
    const visibleKey = JSON.stringify(input.visibleRecipientAccountIds);
    // A resolved identity and an omitted identity are both final for
    // this mounted scope: neither is worth asking twice while the manager pages around.
    const [resolution, setResolution] = React.useState<Readonly<{
        scopeKey: string; labels: Readonly<Record<string, string | null>>;
    }>>({ scopeKey, labels: NO_LABELS });
    const labels = resolution.scopeKey === scopeKey ? resolution.labels : NO_LABELS;
    const labelsRef = React.useRef(labels);
    labelsRef.current = labels;
    const isAlreadyNamedRef = React.useRef(isAlreadyNamed);
    isAlreadyNamedRef.current = isAlreadyNamed;
    const visibleIdsRef = React.useRef(input.visibleRecipientAccountIds);
    visibleIdsRef.current = input.visibleRecipientAccountIds;

    React.useEffect(() => {
        if (!enabled) return;
        if (teamKey === '[]') return;
        const unresolved = [...new Set(visibleIdsRef.current)]
            .filter((accountId) => accountId.length > 0
                && labelsRef.current[accountId] === undefined
                && !isAlreadyNamedRef.current(accountId));
        if (unresolved.length === 0) return;
        const abort = new AbortController();
        void resolveSessionAccessPrincipals({
            scope: { serverId, accountId }, availability: 'available',
            subjects: unresolved.map(accountId => ({ kind: 'account', accountId })),
            signal: abort.signal,
        }).then(principals => {
            if (abort.signal.aborted) return;
            const accounts = new Map(principals.flatMap(principal => principal.kind === 'account'
                ? [[principal.accountId, principal] as const] : []));
            const resolved: Record<string, string | null> = {};
            for (const accountId of unresolved) {
                const account = accounts.get(accountId);
                resolved[accountId] = account ? formatAccountDisplayName(account) : null;
            }
            setResolution(previous => ({ scopeKey, labels: {
                ...(previous.scopeKey === scopeKey ? previous.labels : NO_LABELS), ...resolved,
            } }));
        }).catch(() => {
            // Identity discovery is optional presentation. Unavailable or unsupported
            // Homes retain identifiers and can be asked again on the next visible page.
        });
        return () => abort.abort();
    }, [accountId, enabled, serverId, scopeKey, teamKey, visibleKey]);

    return React.useCallback(
        (accountId: string) => labels[accountId] ?? undefined,
        [labels],
    );
}
