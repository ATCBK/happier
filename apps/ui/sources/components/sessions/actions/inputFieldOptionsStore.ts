import { getActionSpec, type PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import type { ActionFieldOption } from './ActionInputFields';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildSessionActionFieldOptionsResolver } from './sessionActionFieldOptions';

export type InputFieldOptionsState = Readonly<{
    options: readonly ActionFieldOption[];
    status: 'loading' | 'ready' | 'failed';
    errorCode?: string;
}>;
export const EMPTY_INPUT_OPTIONS: readonly ActionFieldOption[] = Object.freeze([]);
export const INPUT_OPTIONS_LOADING: InputFieldOptionsState = Object.freeze({ options: EMPTY_INPUT_OPTIONS, status: 'loading' });
export type InputOptionsRead = Readonly<{
    key: string;
    input: Record<string, unknown>;
    context: Omit<ActionExecutorContext, 'surface' | 'signal'>;
    accountLifetime?: ServerAccountScopeLifetime | null;
    /** Supplied projection has no admitted producer; never route its read to an ambient relay. */
    unavailableReasonCode?: string;
    retention?: Readonly<{ owner: object; field: string; refreshKey?: string }>;
}>;
type ReadEntry = {
    state: InputFieldOptionsState;
    projection: { state: InputFieldOptionsState; refreshKey?: string };
    controller: AbortController;
    listeners: Set<() => void>;
    refreshKey?: string;
    retirement?: Readonly<{ dispose(): void }>;
};

// Card paint and its transcript height projection share the same demanded read.
// The last subscriber releases the active read and its pending request.
const reads = new Map<string, ReadEntry>();
// A mounted view owns demand; the canonical immutable widget owns its last
// admitted choices through responsive/offscreen gaps. Only the latest request
// per field is retained, and both owner and Account lifetime are weak keys.
const retained = new WeakMap<ServerAccountScopeLifetime, WeakMap<object, Map<string, Readonly<{
    key: string; projection: ReadEntry['projection'];
}>>>>();

function retainedProjection(read: InputOptionsRead): ReadEntry['projection'] | undefined {
    if (!read.retention || !read.accountLifetime?.isCurrent()) return undefined;
    const saved = retained.get(read.accountLifetime)?.get(read.retention.owner)?.get(read.retention.field);
    return saved?.key === read.key && saved.projection.refreshKey === read.retention.refreshKey
        && saved.projection.state.status === 'ready' ? saved.projection : undefined;
}

function retainEntry(read: InputOptionsRead, entry: ReadEntry): void {
    if (!read.retention || !read.accountLifetime?.isCurrent()) return;
    let owners = retained.get(read.accountLifetime);
    if (!owners) retained.set(read.accountLifetime, owners = new WeakMap());
    let fields = owners.get(read.retention.owner);
    if (!fields) owners.set(read.retention.owner, fields = new Map());
    if (entry.projection.refreshKey === read.retention.refreshKey) fields.set(read.retention.field, { key: read.key, projection: entry.projection });
}

function load(read: InputOptionsRead, entry: ReadEntry): void {
    const controller = entry.controller;
    if (read.unavailableReasonCode) {
        entry.state = { status: 'failed', options: EMPTY_INPUT_OPTIONS, errorCode: read.unavailableReasonCode };
        entry.projection.state = entry.state;
        entry.listeners.forEach(listener => listener());
        return;
    }
    void callWorkflowAction({
        actionId: 'action.options.resolve', input: read.input, context: read.context, signal: controller.signal,
        ...(read.accountLifetime === undefined ? {} : { accountLifetime: read.accountLifetime }),
        parseResult: (value) => getActionSpec('action.options.resolve').outputSchema!.parse(value) as PublicActionResultById['action.options.resolve'],
    }).then((result) => {
        if (controller.signal.aborted) return;
        const projected = result.optionsSourceId ? buildSessionActionFieldOptionsResolver({ [result.optionsSourceId]: result.options })({ optionsSourceId: result.optionsSourceId }) : result.options;
        const options = JSON.stringify(entry.state.options) === JSON.stringify(projected)
            ? entry.state.options : projected;
        entry.state = { status: 'ready', options };
        entry.projection.state = entry.state;
        entry.listeners.forEach((listener) => listener());
    }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        entry.state = { status: 'failed', options: entry.state.options,
            errorCode: error instanceof WorkflowActionError ? error.rawCode ?? 'action_failed' : 'action_failed' };
        entry.projection.state = entry.state;
        entry.listeners.forEach((listener) => listener());
    });
}

export function readInputFieldOptionsState(read: InputOptionsRead): InputFieldOptionsState {
    if (read.accountLifetime && !read.accountLifetime.isCurrent()) return INPUT_OPTIONS_LOADING;
    const entry = reads.get(read.key);
    const state = entry?.controller.signal.aborted ? INPUT_OPTIONS_LOADING
        : entry?.state ?? retainedProjection(read)?.state ?? INPUT_OPTIONS_LOADING;
    if (entry && entry.refreshKey === read.retention?.refreshKey) retainEntry(read, entry);
    return state;
}

export function subscribeInputFieldOptions(read: InputOptionsRead, listener: () => void, refreshKey?: string): () => void {
    let entry = reads.get(read.key);
    // Explicit Account retirement cancels synchronously, even during a handoff.
    if (entry?.controller.signal.aborted) {
        entry.retirement?.dispose();
        reads.delete(read.key);
        entry = undefined;
    }
    if (!entry) {
        const projection = retainedProjection(read) ?? { state: INPUT_OPTIONS_LOADING, refreshKey };
        entry = { state: projection.state, projection, controller: new AbortController(), listeners: new Set(), refreshKey };
        reads.set(read.key, entry);
        // Adopt the same projection so a refusal retires every previous reader's
        // snapshot even if all subscribers leave before React paints the error.
        retainEntry(read, entry);
        const boundEntry = entry;
        entry.retirement = read.accountLifetime?.onRetire(() => {
            boundEntry.controller.abort();
            boundEntry.state = { status: 'failed', options: EMPTY_INPUT_OPTIONS, errorCode: 'action_account_scope_changed' };
            boundEntry.projection.state = boundEntry.state;
            boundEntry.listeners.forEach(listener => listener());
        });
        load(read, entry);
    }
    entry.listeners.add(listener);
    const subscribedEntry = entry;
    return () => {
        subscribedEntry.listeners.delete(listener);
        if (subscribedEntry.listeners.size === 0) {
            // Responsive recomposition replaces subscribers in the same commit.
            // Release active demand after that handoff.
            queueMicrotask(() => {
                if (subscribedEntry.listeners.size !== 0 || reads.get(read.key) !== subscribedEntry) return;
                subscribedEntry.controller.abort();
                subscribedEntry.retirement?.dispose();
                reads.delete(read.key);
            });
        }
    };
}

export function retryInputFieldOptions(read: InputOptionsRead): void {
    const entry = reads.get(read.key);
    if (!entry) return;
    entry.controller.abort();
    entry.controller = new AbortController();
    if (entry.projection.refreshKey !== entry.refreshKey) {
        entry.projection.state = INPUT_OPTIONS_LOADING;
        entry.projection = { state: INPUT_OPTIONS_LOADING, refreshKey: entry.refreshKey };
    }
    entry.state = { status: entry.state.options.length ? 'ready' : 'loading', options: entry.state.options };
    entry.listeners.forEach((listener) => listener());
    load(read, entry);
}

export function refreshInputFieldOptions(read: InputOptionsRead, refreshKey: string | undefined): void {
    const entry = reads.get(read.key);
    if (!entry || entry.refreshKey === refreshKey) return;
    entry.refreshKey = refreshKey;
    retryInputFieldOptions(read);
}
