import * as React from 'react';
import { readPendingCapabilityApplyV1, readCapabilitySelectionApplyV1, readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { setSessionCapabilitySelectionItemV1, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionCapabilitiesGetOutputV1Schema, SessionCapabilitiesSetOutputV1Schema,
    type SessionCapabilitiesGetOutputV1, type SessionCapabilitiesSetInputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readSessionCapabilityAgentFactsV1, readCapabilityLaunchRestartFromMetadataV1, resolveCapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';

type ItemKind = SessionCapabilitiesSetInputV1['kind'];
type ItemState = SessionCapabilitiesSetInputV1['state'];
/** `previous` is the override the Action replaced (IR-77): what Undo resends, and what tells an add from a removal. */
export type SessionCapabilityWriteResult = Readonly<{ ok: true; previous?: ItemState }> | Readonly<{ ok: false; message: string }>;
type Preview = Extract<SessionCapabilitiesGetOutputV1, { ok: true }>;
type Operation = Readonly<{ kind: ItemKind; id: string; state: ItemState; reason?: string;
    resolve: (value: SessionCapabilityWriteResult) => void }>;
type State = { key: string; metadata: unknown; written: SessionCapabilitySelectionV1; selection: SessionCapabilitySelectionV1;
    pending: Operation[]; running: boolean; mounted: boolean;
    previous: Readonly<{ kind: ItemKind; id: string; state: ItemState }> | null };

/** Session overrides have one optimistic queue; every durable change and Undo goes through the public Action. */
export function useSessionCapabilities(sessionId: string, suppliedMetadata?: unknown,
    options?: Readonly<{ serverId?: string | null }>) {
    const active = useActiveServerSnapshot(!options?.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(options?.serverId ?? active.serverId);
    const subscribe = React.useCallback((listener: () => void) => suppliedMetadata !== undefined
        ? () => {} : subscribeRegisteredStorageState(listener) ?? (() => {}), [suppliedMetadata]);
    const readSession = React.useCallback(() => {
        const registered = readRegisteredStorageState();
        return registered && binding && areServerAccountScopesEqual(registered.sessionLocalStateScope, binding.scope)
            ? selectHomeQualifiedSession(registered, sessionId, binding.scope.serverId, active.serverId) : null;
    }, [sessionId, binding?.scope.serverId, binding?.scope.accountId, active.serverId]);
    const readMetadata = React.useCallback(() => {
        if (suppliedMetadata !== undefined) return suppliedMetadata;
        const session = readSession();
        return session ? readSessionOwnerMetadataView(session) : null;
    }, [suppliedMetadata, readSession]);
    const readRunning = React.useCallback(() => readSession()?.active ?? null, [readSession]);
    const sessionMetadata = React.useSyncExternalStore(subscribe, readMetadata, readMetadata);
    const sessionRunning = React.useSyncExternalStore(subscribe, readRunning, readRunning);
    const execution = useMountedActionExecution(binding?.scope);
    const key = JSON.stringify([binding?.scope.serverId, binding?.scope.accountId, sessionId]);
    const [, render] = React.useState(0);
    const owner = React.useRef<State | null>(null);
    if (!owner.current || owner.current.key !== key) {
        const selection = readSessionCapabilitySelectionFromMetadataV1(sessionMetadata);
        owner.current = { key, metadata: sessionMetadata, written: selection, selection, pending: [], running: false, mounted: true, previous: null };
    }
    const state = owner.current;
    const [demanded, setDemanded] = React.useState(false);
    const [snapshot, setSnapshot] = React.useState<Readonly<{ key: string; value: Preview }> | null>(null);
    const [status, setStatus] = React.useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const request = React.useRef(0);
    const publish = React.useCallback((current: State) => {
        const selection = current.pending.reduce((value, op) => setSessionCapabilitySelectionItemV1(value, op.kind, op.id, op.state), current.written);
        if (JSON.stringify(selection) === JSON.stringify(current.selection)) return;
        current.selection = selection;
        if (owner.current === current && current.mounted) render(value => value + 1);
    }, []);
    React.useEffect(() => { state.mounted = true; return () => { state.mounted = false; request.current += 1; }; }, [state]);
    React.useLayoutEffect(() => {
        if (state.metadata === sessionMetadata) return;
        state.metadata = sessionMetadata;
        state.written = readSessionCapabilitySelectionFromMetadataV1(sessionMetadata);
        publish(state);
    }, [state, sessionMetadata, publish]);
    const refresh = React.useCallback(async () => {
        const turn = ++request.current;
        setStatus('loading'); setError(null);
        try {
            const result = await execution.execute('session.capabilities.get', { sessionId }, { defaultSessionId: sessionId });
            if (turn !== request.current || owner.current !== state || !state.mounted) return;
            const parsed = result.ok ? SessionCapabilitiesGetOutputV1Schema.safeParse(result.result) : null;
            if (parsed?.success && parsed.data.ok) { setSnapshot({ key, value: parsed.data }); setStatus('ready'); }
            else { setStatus('unavailable'); setError(!result.ok ? result.errorCode ?? result.error : parsed?.success && !parsed.data.ok ? parsed.data.code : 'invalid_action_output'); }
        } catch (failure) {
            if (turn !== request.current || owner.current !== state || !state.mounted) return;
            setStatus('unavailable'); setError(failure instanceof Error ? failure.message : String(failure));
        }
    }, [execution.execute, key, sessionId, state]);
    React.useEffect(() => { if (demanded && execution.ready) void refresh(); }, [demanded, execution.ready, refresh]);
    const drain = React.useCallback(async (current: State) => {
        if (current.running) return;
        current.running = true;
        while (current.pending.length) {
            const op = current.pending[0]!;
            let outcome: SessionCapabilityWriteResult;
            try {
                if (owner.current !== current || !current.mounted) outcome = { ok: false, message: 'scope-retired' };
                else {
                    const result = await execution.execute('session.capabilities.set', { sessionId, kind: op.kind, id: op.id, state: op.state,
                        ...(op.reason !== undefined ? { reason: op.reason } : {}) }, { defaultSessionId: sessionId });
                    const parsed = result.ok ? SessionCapabilitiesSetOutputV1Schema.safeParse(result.result) : null;
                    if (parsed?.success && parsed.data.ok) {
                        current.written = setSessionCapabilitySelectionItemV1(current.written, op.kind, op.id, parsed.data.state);
                        current.previous = { kind: op.kind, id: op.id, state: parsed.data.previous };
                        outcome = { ok: true, previous: parsed.data.previous };
                    } else outcome = { ok: false, message: !result.ok ? result.errorCode ?? result.error
                        : parsed?.success && !parsed.data.ok ? parsed.data.code : 'invalid_action_output' };
                }
            } catch (failure) { outcome = { ok: false, message: failure instanceof Error ? failure.message : String(failure) }; }
            current.pending.shift(); publish(current); op.resolve(outcome);
        }
        current.running = false;
        if (demanded && owner.current === current && current.mounted) void refresh();
    }, [execution.execute, sessionId, publish, demanded, refresh]);
    const setItem = React.useCallback((kind: ItemKind, id: string, value: ItemState, reason?: string): Promise<SessionCapabilityWriteResult> => {
        if (owner.current !== state || !state.mounted) return Promise.resolve({ ok: false, message: 'scope-retired' });
        return new Promise(resolve => { state.pending.push({ kind, id, state: value, reason, resolve }); publish(state); void drain(state); });
    }, [state, drain, publish]);
    const undoLast = React.useCallback(() => state.previous ? setItem(state.previous.kind, state.previous.id, state.previous.state)
        : Promise.resolve<SessionCapabilityWriteResult>({ ok: true }), [state, setItem]);
    const preview = snapshot?.key === key ? snapshot.value : null;
    // Desired/applied metadata is the host's current acknowledgment. A last-known
    // Machine preview may still describe the previous pending change.
    const pendingApply = React.useMemo(() => {
        const currentPending = readPendingCapabilityApplyV1(sessionMetadata);
        if (sessionMetadata === null || sessionMetadata === undefined) return preview?.pendingApply ?? currentPending;
        const currentApply = readCapabilitySelectionApplyV1(sessionMetadata);
        // The aggregate notice selects MCP first when both kinds are pending.
        // Never label it with the other kind's refusal while its own record is absent.
        const refusal = currentPending.mcp ? currentApply.mcp : currentApply.skills;
        return { ...currentPending, ...(refusal ? { reason: refusal.reason, ...(refusal.restartBy ? { restartBy: refusal.restartBy } : {}) } : {}) };
    }, [sessionMetadata, preview?.pendingApply]);
    // Apply notices read the host's admitted facts even before the detail preview is demanded.
    const applyTiming = React.useMemo(() => {
        const agent = readSessionCapabilityAgentFactsV1(sessionMetadata);
        if (!agent || sessionRunning === null) return preview?.applyTiming ?? null;
        const input = { agent, sessionRunning, launchRestart: readCapabilityLaunchRestartFromMetadataV1(sessionMetadata) };
        return { mcp: resolveCapabilityApplyTimingV1({ ...input, kind: 'mcp_server' }),
            skills: resolveCapabilityApplyTimingV1({ ...input, kind: 'skill' }) };
    }, [sessionMetadata, sessionRunning, preview?.applyTiming]);
    const demandPreview = React.useCallback(() => {
        if (demanded && execution.ready) void refresh();
        else setDemanded(true);
    }, [demanded, execution.ready, refresh]);
    return { sessionId, scopeKey: key, metadata: sessionMetadata, selection: state.selection, items: preview ? { mcp: preview.mcp.items, skills: preview.skills.items } : null,
        pendingApply, applyTiming,
        preview, lastKnownPreview: preview, status, error, setItem, undoLast, demandPreview, refresh };
}
