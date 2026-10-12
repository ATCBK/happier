import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { processOwnerKey, type HappierProcessRoot, type ProcessOwnerRef } from './types';

export type ProcessOwnerRequester = Readonly<{ accountId: string; displayName?: string }>;
export type ProcessOwnerRequesterContext = Readonly<{
    target: Omit<RequesterWorkAttributionV1, 'accountId'>;
    custodianAccountId: string;
    requesterIdentities?: ReadonlyMap<string, Readonly<{ accountId: string; displayName: string }>>;
}>;

/** Projects admitted lifecycle attribution from this read's roots, never a second ownership store. */
export function resolveProcessOwnerRequester(
    owner: ProcessOwnerRef, roots: readonly HappierProcessRoot[], context: ProcessOwnerRequesterContext,
): ProcessOwnerRequester | null {
    const matching = roots.filter(root => processOwnerKey(root.owner) === processOwnerKey(owner));
    if (matching.length === 0) return null;
    const current = matching.some(root => root.live) ? matching.filter(root => root.live) : matching;
    let stamps = current.flatMap(root => root.requesterWorkAttributionV1 ? [root.requesterWorkAttributionV1] : []);
    if (stamps.length === 0) {
        const sessionIds = new Set([owner, ...current.map(root => root.owner)]
            .flatMap(candidate => 'sessionId' in candidate && candidate.sessionId ? [candidate.sessionId] : []));
        if (sessionIds.size > 1) return null;
        const sessionId = [...sessionIds][0];
        if (sessionId && owner.kind !== 'session') {
            return resolveProcessOwnerRequester({ kind: 'session', sessionId }, roots, context);
        }
        if (owner.kind !== 'happier' && owner.kind !== 'workspace_sync' && owner.kind !== 'browser_sidecar') return null;
        stamps = [{ ...context.target, accountId: context.custodianAccountId }];
    }
    const accountId = stamps[0]!.accountId;
    if (stamps.some(stamp => stamp.accountId !== accountId || stamp.serverId !== context.target.serverId
        || stamp.machineId !== context.target.machineId || stamp.installationId !== context.target.installationId)) return null;
    const identity = context.requesterIdentities?.get(accountId);
    return { accountId, ...(identity?.accountId === accountId ? { displayName: identity.displayName } : {}) };
}
