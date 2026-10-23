import * as React from 'react';
import type { OtherAccountFollowV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { readAccountSessionFollowRelations } from '@/sync/api/session/sessionFollowApi';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isAccountFollowConfigurationChangeRelevant } from '@/components/sessions/follow/sessionFollowAccountChange';
import { readSessionRunningExecutionRuns } from '@/hooks/session/useSessionRunningExecutionRuns';
import { readRunningExecutionRunRoster, subscribeRunningExecutionRunRoster } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { classifyInboxExecutionRun, type InboxExecutionRun } from '@/components/inbox/inboxItems';

type RunFollow = OtherAccountFollowV1 & Readonly<{ source: { kind: 'execution_run'; sessionId: string; runId: string } }>;
type Source = Readonly<{ entries: readonly InboxExecutionRun[]; loading: boolean; failed: boolean }>;
const EMPTY_ENTRIES: readonly InboxExecutionRun[] = Object.freeze([]);
const EMPTY_SOURCE: Source = Object.freeze({ entries: EMPTY_ENTRIES, loading: false, failed: false });
const SourceContext = React.createContext<Source | null>(null);
const CountContext = React.createContext(0);

/** Private Follow selects identities; the existing demanded Run roster owns live facts and recovery. */
function useCreateSource(): Source {
    const lifetime = useActiveServerAccountScopeLifetime();
    const scope = lifetime?.scope;
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: scope?.serverId ?? '' });
    const [census, setCensus] = React.useState<Readonly<{
        lifetime: typeof lifetime; follows: readonly RunFollow[]; loading: boolean; failed: boolean;
    }> | null>(null);
    React.useEffect(() => {
        if (!enabled || !lifetime?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        let running = false;
        let dirty = false;
        const refresh = async () => {
            if (running) { dirty = true; return; }
            running = true;
            try {
                do {
                    dirty = false;
                    setCensus(previous => ({ lifetime, follows: previous?.lifetime === lifetime ? previous.follows : [], loading: true, failed: false }));
                    const follows: RunFollow[] = [];
                    let cursor: string | undefined;
                    do {
                        const result = await readAccountSessionFollowRelations(lifetime.scope,
                            cursor ? { cursor } : undefined, controller.signal);
                        if (controller.signal.aborted || !lifetime.isCurrent()) return;
                        if (result.kind !== 'ok') throw new Error('unavailable');
                        for (const follow of result.value.follows) {
                            if ('source' in follow && follow.source.kind === 'execution_run' && follow.following && follow.persistent) {
                                follows.push({ ...follow, source: follow.source });
                            }
                        }
                        cursor = result.value.continuation;
                    } while (cursor);
                    setCensus(previous => ({ lifetime,
                        follows: previous?.lifetime === lifetime && JSON.stringify(previous.follows) === JSON.stringify(follows) ? previous.follows : follows,
                        loading: false, failed: false }));
                } while (dirty && !controller.signal.aborted && lifetime.isCurrent());
            } catch {
                if (!controller.signal.aborted && lifetime.isCurrent()) setCensus(previous => ({ lifetime,
                    follows: previous?.lifetime === lifetime ? previous.follows : [], loading: false, failed: true }));
            } finally { running = false; }
        };
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (lifetime.isCurrent() && areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)
                && isAccountFollowConfigurationChangeRelevant(event)) void refresh();
        });
        void refresh();
        return () => { controller.abort(); retirement.dispose(); unsubscribe(); };
    }, [enabled, lifetime]);
    const follows = enabled && lifetime?.isCurrent() && census?.lifetime === lifetime ? census.follows : null;
    const [projection, setProjection] = React.useState<Readonly<{ follows: typeof follows; entries: readonly InboxExecutionRun[] }> | null>(null);
    React.useEffect(() => {
        if (!follows || !lifetime?.isCurrent()) return;
        const addresses = new Map<string, SessionAddress>();
        for (const follow of follows) {
            const address = { serverId: lifetime.scope.serverId, sessionId: follow.source.sessionId };
            addresses.set(sessionAddressKey(address), address);
        }
        let disposed = false;
        const publish = () => {
            if (disposed || !lifetime.isCurrent()) return;
            const entries: InboxExecutionRun[] = [];
            const seen = new Set<string>();
            for (const follow of follows) {
                const address = { serverId: lifetime.scope.serverId, sessionId: follow.source.sessionId };
                const key = JSON.stringify([sessionAddressKey(address), follow.source.runId]);
                if (seen.has(key)) continue;
                seen.add(key);
                const run = readRunningExecutionRunRoster(address).find(run => run.runId === follow.source.runId);
                if (run && classifyInboxExecutionRun(run)) entries.push({ address, run });
            }
            setProjection(previous => previous?.follows === follows && entries.length === previous.entries.length
                && entries.every((entry, index) => entry.run === previous.entries[index]?.run) ? previous : { follows, entries });
        };
        const unsubscribes = [...addresses.values()].map(address => subscribeRunningExecutionRunRoster(address, publish,
            () => readSessionRunningExecutionRuns(address)));
        const retirement = lifetime.onRetire(() => { disposed = true; setProjection(null); });
        publish();
        return () => { disposed = true; retirement.dispose(); for (const unsubscribe of unsubscribes) unsubscribe(); };
    }, [follows, lifetime]);
    return React.useMemo(() => !enabled || !lifetime?.isCurrent() ? EMPTY_SOURCE : {
        entries: follows && projection?.follows === follows ? projection.entries : EMPTY_ENTRIES,
        loading: census?.lifetime !== lifetime || census.loading,
        failed: census?.lifetime === lifetime && census.failed,
    }, [enabled, lifetime, follows, projection, census]);
}

function SourceProvider(props: Readonly<{ children: React.ReactNode }>) {
    const source = useCreateSource();
    // A Run's title/permission refresh cannot rerender the always-mounted count consumer.
    return <CountContext.Provider value={source.entries.length}><SourceContext.Provider value={source}>
        {props.children}
    </SourceContext.Provider></CountContext.Provider>;
}

export function InboxExecutionRunSourceBoundary(props: Readonly<{ children: React.ReactNode }>) {
    const existing = React.useContext(SourceContext);
    return existing ? <>{props.children}</> : <SourceProvider>{props.children}</SourceProvider>;
}
export function useInboxExecutionRunSource(): Source { return React.useContext(SourceContext) ?? EMPTY_SOURCE; }
export function useInboxExecutionRunCount(): number { return React.useContext(CountContext); }
