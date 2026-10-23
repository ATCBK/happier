import * as React from 'react';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { SessionSystemRecordObservationBase, SessionSystemRecordUnavailableReason } from './observation';

type BoardCountInput = Readonly<{ serverId: string | null; sessionId: string; enabled: boolean }>;
type BoardCountRuntime = Pick<SessionSystemRecordObservationBase, 'repository' | 'isCurrent' | 'readCapabilities'>;
const selectBoardItemCount = (count: number | null) => count;
const selectBoardHasItems = (count: number | null) => count === null ? null : count > 0;

/** Scalar demand belongs to the mounted Session model, independently of pane presentation. */
function useSessionBoardCountProjection<T extends number | boolean | null>(input: BoardCountInput, select: (count: number | null) => T): T {
    const address = React.useMemo(() => normalizeSessionAddress(input.serverId, input.sessionId), [input.serverId, input.sessionId]);
    const resolution = useServerCredentialAccountScopeResolution(address?.serverId);
    const sync = getSyncSingleton();
    const lifetime = React.useMemo(() => ({ address, resolution }), [address, resolution]);
    const [observed, setObserved] = React.useState<Readonly<{ lifetime: typeof lifetime; runtime: BoardCountRuntime }> | null>(null);
    const retained = input.enabled && address ? sync.readSessionSystemRecordObservation(address) : null;
    const retainedAllowed = retained && (resolution.kind === 'resolving'
        || (resolution.kind === 'bound' && resolution.scope.accountId === retained.repository.scope.accountId));
    const runtime = observed?.lifetime === lifetime ? observed.runtime : retainedAllowed ? retained : null;
    React.useEffect(() => {
        if (!input.enabled || !address || resolution.kind !== 'bound') return;
        let stopped = false;
        let release: (() => void) | undefined;
        const start = (current: BoardCountRuntime) => {
            if (stopped || !current.isCurrent() || current.readCapabilities()?.readTranscript !== true
                || (resolution.kind === 'bound' && current.repository.scope.accountId !== resolution.scope.accountId)) return;
            release = current.repository.acquireBoardItemCount(address, current);
            setObserved({ lifetime, runtime: current });
        };
        if (retainedAllowed && retained) start(retained);
        else void sync.withSessionSystemRecordRuntime(address, async current => start({
            repository: current.repository, isCurrent: current.isCurrent,
            readCapabilities: () => current.readSession()?.access?.capabilities ?? null,
        })).catch(() => undefined);
        return () => { stopped = true; release?.(); };
    // Retained wrappers do not own demand; the exact Session/credential lifetime does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [address, input.enabled, lifetime, resolution]);
    const subscribe = React.useCallback((listener: () => void) => input.enabled && address && runtime
        ? runtime.repository.subscribeBoardItemCount(address, listener) : () => undefined, [address, input.enabled, runtime]);
    const getSnapshot = React.useCallback(() => select(input.enabled && address && runtime?.isCurrent()
        && runtime.readCapabilities()?.readTranscript === true ? runtime.repository.readBoardItemCount(address) : null), [address, input.enabled, runtime, select]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSessionBoardItemCount(input: BoardCountInput): number | null {
    return useSessionBoardCountProjection(input, selectBoardItemCount);
}

/** Positive-to-positive updates leave rail placement consumers untouched. */
export function useSessionBoardHasItems(input: BoardCountInput): boolean | null {
    return useSessionBoardCountProjection(input, selectBoardHasItems);
}

export type SessionSystemRecordUnavailable = Readonly<{ status: 'unavailable'; reason: SessionSystemRecordUnavailableReason }>;
type Unavailable<Reason extends string> = Readonly<{ status: 'unavailable'; reason: SessionSystemRecordUnavailableReason | Reason }>;
export type SessionSystemRecordObservationOptions<Binding, Reason extends string = never> = SessionSystemRecordObservationBase & Readonly<{ onChange: (binding: Binding | Unavailable<Reason>) => void }>;

/** Exact-Home authority and observation lifetime shared by Board and individual Session content. */
export function useSessionSystemRecordBinding<Binding extends { status: 'ready' }, Reason extends string = never>(input: Readonly<{
    serverId: string | null;
    sessionId: string;
    enabled: boolean;
    loading: Binding;
    observe: (options: SessionSystemRecordObservationOptions<Binding, Reason>) => () => void;
    read?: (options: Pick<SessionSystemRecordObservationBase, 'session' | 'repository' | 'isCurrent' | 'readCapabilities' | 'readContentContext'>) => Binding | Unavailable<Reason> | null;
}>): (Binding | Unavailable<Reason>) & Readonly<{ refresh: () => void }> {
    const address = React.useMemo(() => normalizeSessionAddress(input.serverId, input.sessionId), [input.serverId, input.sessionId]);
    const resolution = useServerCredentialAccountScopeResolution(address?.serverId);
    const lifetime = React.useMemo(() => ({ address, resolution, observe: input.observe }), [address, resolution, input.observe]);
    const sync = getSyncSingleton();
    const retained = address && input.read ? sync.readSessionSystemRecordObservation(address) : null;
    const retainedAllowed = retained && (resolution.kind === 'resolving'
        || (resolution.kind === 'bound' && resolution.scope.accountId === retained.repository.scope.accountId));
    const retainedBinding = retainedAllowed ? input.read?.(retained) : null;
    const [retry, setRetry] = React.useState(0);
    const [observed, setObserved] = React.useState<Readonly<{
        lifetime: typeof lifetime;
        binding: Binding | Unavailable<Reason>;
        isCurrent: () => boolean;
        refreshRecords?: () => void;
    }> | null>(null);
    React.useEffect(() => {
        if (!input.enabled || !address || (resolution.kind !== 'bound' && !retainedAllowed)) return;
        let stopped = false;
        let unsubscribe: (() => void) | undefined;
        const publish = (binding: Binding | Unavailable<Reason>, isCurrent = () => !stopped, refreshRecords?: () => void) => {
            if (!stopped) setObserved({ lifetime, binding, isCurrent, refreshRecords });
        };
        const start = (runtime: Pick<SessionSystemRecordObservationBase, 'repository' | 'readCapabilities' | 'readContentContext' | 'isCurrent'>
            & Readonly<{ scope: SessionSystemRecordObservationBase['repository']['scope'] }>) => {
            if (stopped) return;
            if ((resolution.kind === 'bound' && runtime.scope.accountId !== resolution.scope.accountId) || !runtime.isCurrent()) {
                publish({ status: 'unavailable', reason: 'forbidden' });
                return;
            }
            const readCapabilities = runtime.readCapabilities;
            const capabilities = readCapabilities();
            if (!capabilities?.readTranscript) { publish({ status: 'unavailable', reason: 'forbidden' }); return; }
            unsubscribe = input.observe({
                session: address, repository: runtime.repository,
                authority: { contentContext: runtime.readContentContext(), capabilities },
                readCapabilities, readContentContext: runtime.readContentContext,
                isCurrent: () => !stopped && runtime.isCurrent(),
                renewAuthority: async () => {
                    const renewed = await sync.withSessionSystemRecordRuntime(address, async current => {
                        if (current.repository !== runtime.repository || current.scope.accountId !== runtime.scope.accountId) return null;
                        const currentCapabilities = current.readSession()?.access?.capabilities ?? null;
                        return currentCapabilities ? { contentContext: current.readContentContext(), capabilities: currentCapabilities } : null;
                    }, { forceSessionRefresh: true });
                    if (renewed.status !== 'ok') return renewed;
                    return renewed.value ? { status: 'ok', value: renewed.value } : { status: 'forbidden' };
                },
                onChange: binding => publish(binding, runtime.isCurrent, () => runtime.repository.invalidate(address)),
            });
        };
        if (retainedAllowed && retained) start(retained);
        else void sync.withSessionSystemRecordRuntime(address, async runtime => start({
            scope: runtime.scope, repository: runtime.repository, readCapabilities: () => runtime.readSession()?.access?.capabilities ?? null,
            readContentContext: runtime.readContentContext, isCurrent: runtime.isCurrent,
        })).then(result => {
            if (result.status !== 'ok') publish({ status: 'unavailable', reason: result.status });
        }).catch(() => publish({ status: 'unavailable', reason: 'offline' }));
        return () => { stopped = true; unsubscribe?.(); };
    // The retained wrapper is selected by address/lifetime, not by its object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [address, input.enabled, input.observe, lifetime, resolution, retry]);
    const observedRef = React.useRef(observed);
    observedRef.current = observed;
    const refresh = React.useCallback(() => {
        const current = observedRef.current;
        if (current?.lifetime === lifetime && current.isCurrent() && current.binding.status === 'ready' && current.refreshRecords) current.refreshRecords();
        else { setObserved(null); setRetry(value => value + 1); }
    }, [lifetime]);
    const binding: Binding | Unavailable<Reason> = !address
        ? { status: 'unavailable', reason: 'invalid_address' }
        : resolution.kind !== 'bound'
            ? resolution.kind === 'resolving' ? retainedBinding ?? input.loading : { status: 'unavailable', reason: resolution.kind }
            : observed?.lifetime !== lifetime
                ? retainedBinding ?? input.loading
                : !observed.isCurrent() ? { status: 'unavailable', reason: 'forbidden' } : observed.binding;
    const ready = binding.status === 'ready' ? binding : null;
    const reason = binding.status === 'unavailable' ? binding.reason : 'forbidden';
    return React.useMemo(() => ready ? { ...ready, refresh } : { status: 'unavailable' as const, reason, refresh }, [ready, reason, refresh]);
}
