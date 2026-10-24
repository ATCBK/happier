import type {
    LanguageIntelligenceSyncInput, LanguageIntelligenceSyncResult, LanguageIntelligenceQueryInput, LanguageIntelligenceQueryResult,
    LanguageIntelligenceWatchInput, LanguageIntelligenceWatchResult, LanguageIntelligenceRestartResult, LanguageIntelligenceServerStatus,
} from '@happier-dev/protocol/machines/languageIntelligence';
import { diffToSingleEdit } from './diffToSingleEdit';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';

export type CodeIntelligenceServerPort = Readonly<{
    sync(input: LanguageIntelligenceSyncInput, signal?: AbortSignal): Promise<LanguageIntelligenceSyncResult>;
    query(input: LanguageIntelligenceQueryInput, signal: AbortSignal): Promise<LanguageIntelligenceQueryResult>;
    watch(input: LanguageIntelligenceWatchInput, signal: AbortSignal): Promise<LanguageIntelligenceWatchResult>;
    /** Supplied by the app Action executor, never a direct UI restart RPC. */
    restart(signal?: AbortSignal): Promise<LanguageIntelligenceRestartResult>;
}>;
/** Query details only; document identity and freshness always belong to this holder. */
export type CodeIntelligenceQueryOptions = Omit<LanguageIntelligenceQueryInput,
    'rootPath' | 'path' | 'kind' | 'version' | 'generation' | 'text'>;
type SyncOk = Extract<LanguageIntelligenceSyncResult, { status: 'ok' }>;
type WatchOk = Extract<LanguageIntelligenceWatchResult, { status: 'ok' }>;

/** Transport/document custody beneath the one File-page controller. Construction is passive. */
export function createCodeIntelligenceDocument(input: Readonly<{
    rootPath: string; path: string; languageId: string; port: CodeIntelligenceServerPort;
    getText(): string; getUnsaved(): boolean; isCurrent(): boolean;
    onSync(value: SyncOk, previousGeneration: string | null): void; onWatch(value: WatchOk): void; onUnavailable(reason: string): void;
    onSynchronize?(): void;
}>) {
    let activated = false;
    let disposed = false;
    let opening: Promise<LanguageIntelligenceSyncResult> | null = null;
    let lastResult: LanguageIntelligenceSyncResult | null = null;
    let acknowledged: { text: string; unsaved: boolean; version: number; generation: string } | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    const watchAbort = new AbortController();
    let activeWatch: AbortController | null = null;
    let watching = false;
    let servers: readonly LanguageIntelligenceServerStatus[] = [];
    let needsSnapshot = false;

    function enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const next = queue.then(operation, operation);
        queue = next.catch(() => undefined);
        return next;
    }
    function current(): boolean { return !disposed && input.isCurrent(); }
    function sessionMoved(issued: readonly LanguageIntelligenceServerStatus[]): boolean {
        return issued.some(previous => {
            const now = servers.find(server => server.serverId === previous.serverId);
            return !now || now.generation !== previous.generation || (now.state !== previous.state
                && (now.state === 'crashed' || now.state === 'unavailable' || now.state === 'stopped'));
        });
    }
    function accept(result: LanguageIntelligenceSyncResult, text: string, unsaved: boolean, version: number): void {
        lastResult = result;
        if (result.status !== 'ok') return;
        const previousGeneration = acknowledged?.generation ?? null;
        const acceptedVersion = result.version ?? version;
        // Equal sync acknowledgements do not replace the held query fence.
        // A genuine revision still replaces it, including edit-then-restore.
        if (!acknowledged || acknowledged.text !== text || acknowledged.unsaved !== unsaved
            || acknowledged.version !== acceptedVersion || acknowledged.generation !== result.generation) {
            acknowledged = { text, unsaved, version: acceptedVersion, generation: result.generation };
        }
        // Sync names this document's servers; only the root watch can retire
        // other server identities from the existing root delivery fence.
        servers = [...servers.filter(previous => !result.servers.some(next => next.serverId === previous.serverId)), ...result.servers];
        needsSnapshot = false;
        // Watch revisions belong to the acknowledged daemon root, not the
        // mounted controller. A replacement root starts its own revision stream.
        if (previousGeneration !== null && previousGeneration !== result.generation) activeWatch?.abort();
        if (current()) input.onSync(result, previousGeneration);
        void watch();
    }
    async function watch(): Promise<void> {
        if (watching || !current()) return;
        watching = true;
        const controller = new AbortController();
        activeWatch = controller;
        const cancellation = mergeAbortSignals([watchAbort.signal, controller.signal]);
        const signal = cancellation.signal;
        let revision: number | undefined;
        try {
            while (current() && !signal.aborted) {
                let issuedServers = servers;
                // A pre-ack watch belongs to the opening lease. Once that lease
                // acknowledges, use its identities to fence a later restart,
                // without discarding genuine startup/project-progress events.
                if (!acknowledged && opening) void opening.then(result => {
                    if (result.status === 'ok') issuedServers = result.servers;
                }, () => undefined);
                const result = await input.port.watch({ rootPath: input.rootPath, ...(revision === undefined ? {} : { sinceRevision: revision }) }, signal);
                if (!current() || signal.aborted) return;
                // A sync/restart can acknowledge a new generation while this watch is parked.
                // Re-arm at the same revision rather than letting its old response retire that acknowledgement.
                if (sessionMoved(issuedServers)) continue;
                if (result.status !== 'ok') {
                    input.onUnavailable(result.status === 'unavailable' ? result.reason : result.status === 'error' ? result.errorCode : 'loading');
                    return;
                }
                revision = result.revision;
                if (servers.some(previous => result.servers.some(next => next.serverId === previous.serverId && next.generation !== previous.generation))) needsSnapshot = true;
                servers = result.servers;
                input.onWatch(result);
            }
        } catch { if (current() && !signal.aborted) input.onUnavailable('transport_failed'); }
        finally {
            cancellation.dispose();
            if (activeWatch === controller) activeWatch = null;
            watching = false;
            if (current() && acknowledged && controller.signal.aborted && !watchAbort.signal.aborted) void watch();
        }
    }
    function synchronize(activate = false): Promise<LanguageIntelligenceSyncResult | null> {
        if (!current() || (!activated && !activate)) return Promise.resolve(null);
        input.onSynchronize?.();
        if (!activated) {
            activated = true;
            void enqueue(async (): Promise<LanguageIntelligenceSyncResult> => {
                if (!current()) return { status: 'unavailable', reason: 'session_unavailable' };
                const text = input.getText(); const unsaved = input.getUnsaved();
                try {
                    // Non-null means an open was actually sent, not merely queued.
                    opening = input.port.sync({ rootPath: input.rootPath, op: {
                        op: 'open', path: input.path, languageId: input.languageId, version: 1, text, unsaved,
                    } }, watchAbort.signal);
                    // Startup/project progress is already available on the existing
                    // root watch; initialization need not acknowledge first.
                    void watch();
                    const result = await opening;
                    accept(result, text, unsaved, 1);
                    if (result.status === 'ok') void watch();
                    else activeWatch?.abort();
                    return result;
                } catch (error) {
                    activeWatch?.abort();
                    lastResult = { status: 'unavailable', reason: 'transport_failed' };
                    throw error;
                }
            }).catch(() => undefined);
        }
        return enqueue(async () => {
            if (!current()) return null;
            if (!acknowledged) return lastResult ?? await opening;
            const text = input.getText(); const unsaved = input.getUnsaved();
            const edit = diffToSingleEdit(acknowledged.text, text);
            if (!edit && acknowledged.unsaved === unsaved && !needsSnapshot) {
                // A later user operation resumes a disconnected delivery channel;
                // the parked watch owns its cadence, without a retry timer.
                void watch();
                return lastResult;
            }
            const version = acknowledged.version + 1;
            if (needsSnapshot) return snapshot(version, text, unsaved);
            const result = await input.port.sync({ rootPath: input.rootPath, op: edit ? {
                op: 'change', path: input.path, baseVersion: acknowledged.version, version, edit, unsaved,
            } : { op: 'snapshot', path: input.path, languageId: input.languageId, version, text, unsaved } });
            if (result.status === 'error' && result.errorCode === 'document_out_of_sync') return snapshot(version, text, unsaved);
            accept(result, text, unsaved, version);
            return result;
        });
    }
    async function snapshot(version: number, text: string, unsaved: boolean): Promise<LanguageIntelligenceSyncResult> {
        if (!current()) return { status: 'unavailable', reason: 'session_unavailable' };
        let result = await input.port.sync({ rootPath: input.rootPath, op: {
            op: 'snapshot', path: input.path, languageId: input.languageId, version, text, unsaved,
        } }, watchAbort.signal);
        // A new daemon has no document lease to snapshot. Only this typed
        // missing-holder response authorizes reacquiring our normal open.
        if (result.status === 'error' && result.errorCode === 'document_out_of_sync' && current()) {
            result = await input.port.sync({ rootPath: input.rootPath, op: {
                op: 'open', path: input.path, languageId: input.languageId, version, text, unsaved,
            } }, watchAbort.signal);
        }
        accept(result, text, unsaved, version);
        return result;
    }
    return {
        isActivated: () => activated,
        getAcknowledged: () => acknowledged,
        synchronize,
        async query(kind: LanguageIntelligenceQueryInput['kind'], position: LanguageIntelligenceQueryInput['position'], callerSignal: AbortSignal,
            activate = true, options: CodeIntelligenceQueryOptions = {}): Promise<LanguageIntelligenceQueryResult | null> {
            const cancellation = mergeAbortSignals([callerSignal, watchAbort.signal]);
            const signal = cancellation.signal;
            try {
                const synced = await synchronize(activate);
                if (!current() || signal.aborted || !synced) return null;
                if (synced.status !== 'ok') return synced;
                const held = acknowledged;
                if (!held) return { status: 'unavailable', reason: 'session_unavailable' };
                const request: LanguageIntelligenceQueryInput = { ...options, rootPath: input.rootPath, path: input.path, kind,
                    version: held.version, generation: held.generation, text: 'held', ...(position ? { position } : {}) };
                const issuedServers = servers;
                const result = await input.port.query(request, signal);
                if (!current() || signal.aborted) return null;
                const resynchronize = result.status === 'error' && (result.errorCode === 'document_out_of_sync' || result.errorCode === 'stale_query');
                if (acknowledged !== held || held.text !== input.getText() || held.unsaved !== input.getUnsaved()
                    || sessionMoved(issuedServers) && !resynchronize) return { status: 'error', errorCode: 'stale_query' };
                if (resynchronize) {
                    const restored = await enqueue(() => snapshot((acknowledged?.version ?? 0) + 1, input.getText(), input.getUnsaved()));
                    if (!current() || signal.aborted) return null;
                    if (restored.status !== 'ok') return restored;
                    const retryHeld = acknowledged;
                    if (!retryHeld) return { status: 'unavailable', reason: 'session_unavailable' };
                    const retryServers = servers;
                    const retried = await input.port.query({ ...request, version: retryHeld.version, generation: restored.generation }, signal);
                    if (!current() || signal.aborted) return null;
                    if (acknowledged !== retryHeld || retryHeld.text !== input.getText() || retryHeld.unsaved !== input.getUnsaved()
                        || sessionMoved(retryServers)) return { status: 'error', errorCode: 'stale_query' };
                    if (retried.status === 'ok') void watch();
                    return retried;
                }
                if (result.status === 'ok') void watch();
                return result;
            } finally { cancellation.dispose(); }
        },
        async external(paths: readonly string[]): Promise<void> {
            if (!activated || !current()) return;
            await input.port.sync({ rootPath: input.rootPath, op: { op: 'external', paths: [...paths] } });
        },
        async restart(): Promise<LanguageIntelligenceRestartResult> {
            if (!activated || !current()) return { status: 'unavailable', reason: 'session_unavailable' };
            const response = await input.port.restart(watchAbort.signal);
            if (response.status === 'ok' && current()) {
                await enqueue(() => snapshot((acknowledged?.version ?? 0) + 1, input.getText(), input.getUnsaved()));
                if (!watching) void watch();
            }
            return response;
        },
        dispose(): void {
            if (disposed) return;
            disposed = true; watchAbort.abort();
            // Closing must preempt an unresponsive startup acknowledgement. The host
            // owns ordering/reclamation; a never-sent open must not close another holder.
            if (opening) void Promise.resolve().then(() => input.port.sync({ rootPath: input.rootPath,
                op: { op: 'close', path: input.path } })).catch(() => undefined);
        },
    };
}
