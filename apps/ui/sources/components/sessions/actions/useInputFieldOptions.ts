import * as React from 'react';
import type { ActionInputFieldHint } from '@happier-dev/protocol';
import { projectInputOptionsDependencies } from '@happier-dev/protocol/inputs';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { resolveUiAccountActionFallbackMachineId } from '@/sync/ops/actions/accountActionDeps';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ResolveSessionActionFieldOptions, InputFieldOptionsContext } from './sessionActionFieldOptions';
import {
    EMPTY_INPUT_OPTIONS, INPUT_OPTIONS_LOADING, readInputFieldOptionsState, subscribeInputFieldOptions,
    retryInputFieldOptions, refreshInputFieldOptions, type InputFieldOptionsState, type InputOptionsRead,
} from './inputFieldOptionsStore';

export type InputFieldOptionsRequest = InputFieldOptionsContext & Readonly<{
    field: Pick<ActionInputFieldHint, 'path' | 'optionsSourceId' | 'options' | 'inputType' | 'connectedAccountOptions'>;
}>;
const NO_READS: readonly InputOptionsRead[] = Object.freeze([]);

function hasLocalStaticOptions(field: InputFieldOptionsRequest['field']): boolean {
    // Contributed types may also restrict choices through their serving Resource.
    return field.options !== undefined && (!field.inputType || 'hostType' in field.inputType);
}

function fieldKey(field: Pick<ActionInputFieldHint, 'optionsSourceId' | 'inputType'> & { path?: string }, context?: InputFieldOptionsContext): string {
    return JSON.stringify([field.path, field.optionsSourceId, field.inputType, context?.actionId, context?.consumer,
        projectInputOptionsDependencies(context?.draftInput ?? {}, context?.consumer)]);
}

/** Account choices do not release their demand when a sibling's serving relay changes. */
function useInputOptionsReadGroup(reads: readonly InputOptionsRead[], enabled: boolean, refresh: string | undefined,
    accountLifetime: ServerAccountScopeLifetime | null | undefined, retentionOwner: object | undefined) {
    const identity = JSON.stringify(reads.map(read => read.key));
    // The read key already contains its complete admitted request and Account revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const retainedReads = React.useMemo(() => reads, [identity, accountLifetime, retentionOwner, refresh]);
    const activeReads = enabled ? retainedReads : NO_READS;
    const refreshKey = React.useRef(refresh);
    refreshKey.current = refresh;
    const subscribe = React.useCallback((listener: () => void) => {
        const releases = activeReads.map(read => subscribeInputFieldOptions(read, listener, refreshKey.current));
        return () => releases.forEach(release => release());
    }, [activeReads]);
    const retainedSnapshot = React.useRef<readonly InputFieldOptionsState[]>([]);
    const getSnapshot = React.useCallback(() => {
        const states = activeReads.map(read => readInputFieldOptionsState(read));
        if (states.length === retainedSnapshot.current.length && states.every((state, index) => state === retainedSnapshot.current[index])) {
            return retainedSnapshot.current;
        }
        retainedSnapshot.current = states;
        return states;
    }, [activeReads]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        activeReads.forEach(read => refreshInputFieldOptions(read, refresh));
    }, [activeReads, refresh]);
    return { reads: activeReads, snapshot };
}

/** Demand projection over Action discovery, including cancellation and exact Account/target identity. */
export function useInputFieldOptions(params: Readonly<{
    requests: readonly InputFieldOptionsRequest[];
    enabled: boolean;
    machineId?: string | null;
    sessionId?: string | null;
    serverId?: string | null;
    /** Inventory facts invalidate choices; they never implement a source locally. */
    refreshKey?: string;
    /** Explicit routed Account custody; null is unavailable, never ambient fallback. */
    accountLifetime?: (ServerAccountScopeLifetime & Partial<Pick<ServerCredentialAccountScopeBinding, 'revision'>>) | null;
    /** Canonical immutable placement, never a draft or component-local object. */
    retentionOwner?: object;
}>) {
    const scope = useActiveServerAccountScope(params.serverId ?? undefined);
    const accountScope = params.accountLifetime === undefined ? scope : params.accountLifetime?.scope;
    // Pin the same incumbent Account relay for the options read and the picker mount.
    // A later transport fallback must not give a field machine-B choices beside machine-A's type.
    const optionServerId = params.serverId ?? accountScope?.serverId;
    const machineId = params.machineId ?? (!params.sessionId && optionServerId && accountScope
        && areServerProfileIdentifiersEquivalent(optionServerId, accountScope.serverId)
        && params.requests.some(request => request.field.inputType && 'pluginId' in request.field.inputType)
        ? resolveUiAccountActionFallbackMachineId(accountScope) : null);
    const signature = JSON.stringify([accountScope?.accountId, params.accountLifetime?.revision, optionServerId, machineId,
        params.sessionId, params.requests.map((request) => ({ ...request,
            draftInput: projectInputOptionsDependencies(request.draftInput ?? {}, request.consumer) }))]);
    const { reads, keys, defaultContexts } = React.useMemo(() => {
        const keys = new Map<string, string>();
        const defaultContexts = new Map<string, InputFieldOptionsContext>();
        const reads = new Map<string, InputOptionsRead>();
        for (const request of params.requests) {
            if ((!request.field.optionsSourceId && !request.field.inputType && !request.field.connectedAccountOptions) || hasLocalStaticOptions(request.field)) continue;
            const requestMachineId = params.machineId ?? (request.field.inputType && 'pluginId' in request.field.inputType ? machineId : null);
            const input = { ...(request.field.optionsSourceId ? { optionsSourceId: request.field.optionsSourceId } : {}),
                ...(request.actionId ? { actionId: request.actionId, fieldPath: request.field.path } : {}),
                ...(request.consumer ? { consumer: request.consumer, fieldPath: request.field.path } : {}),
                draftInput: { ...projectInputOptionsDependencies(request.draftInput ?? {}, request.consumer),
                    ...(requestMachineId ? { machineId: requestMachineId } : {}),
                    ...(params.sessionId ? { sessionId: params.sessionId } : {}) },
            };
            const serverId = params.serverId ?? accountScope?.serverId;
            const context = { ...(serverId ? { serverId } : {}),
                ...(requestMachineId ? { externalActionTarget: { kind: 'machine' as const, machineId: requestMachineId } } : {}),
                ...(accountScope?.accountId ? { runtimeAccountId: accountScope.accountId } : {}),
                ...(params.sessionId ? { defaultSessionId: params.sessionId } : {}) };
            const key = JSON.stringify([input, context, params.accountLifetime?.revision]);
            reads.set(key, { key, input, context, ...(params.accountLifetime === undefined ? {} : { accountLifetime: params.accountLifetime }),
                ...(params.retentionOwner ? { retention: { owner: params.retentionOwner, field: request.field.path, refreshKey: params.refreshKey } } : {}) });
            keys.set(fieldKey(request.field, request), key);
            defaultContexts.set(JSON.stringify([request.field.path, request.field.optionsSourceId, request.field.inputType]), request);
        }
        return { reads: [...reads.values()], keys, defaultContexts };
    }, [signature, params.accountLifetime, params.retentionOwner, params.refreshKey]);
    const enabled = params.enabled && (params.accountLifetime === undefined || params.accountLifetime?.isCurrent() === true);
    const accountReads = useInputOptionsReadGroup(reads.filter(read => !read.context.externalActionTarget), enabled, params.refreshKey, params.accountLifetime, params.retentionOwner);
    const machineReads = useInputOptionsReadGroup(reads.filter(read => read.context.externalActionTarget), enabled, params.refreshKey, params.accountLifetime, params.retentionOwner);
    const activeReads = enabled ? reads : NO_READS;
    const snapshot = React.useMemo(() => {
        const states = new Map<string, InputFieldOptionsState>();
        for (const group of [accountReads, machineReads]) {
            group.reads.forEach((read, index) => states.set(read.key, group.snapshot[index] ?? INPUT_OPTIONS_LOADING));
        }
        return activeReads.map(read => states.get(read.key) ?? INPUT_OPTIONS_LOADING);
    }, [activeReads, accountReads.reads, accountReads.snapshot, machineReads.reads, machineReads.snapshot]);
    const state = React.useCallback((field: InputFieldOptionsRequest['field'], context?: InputFieldOptionsContext): InputFieldOptionsState => {
        if (hasLocalStaticOptions(field) || (!field.optionsSourceId && !field.inputType && !field.connectedAccountOptions)) return { options: field.options ?? EMPTY_INPUT_OPTIONS, status: 'ready' };
        const effectiveContext = context ?? defaultContexts.get(JSON.stringify([field.path, field.optionsSourceId, field.inputType]));
        const key = keys.get(fieldKey(field, effectiveContext));
        const index = activeReads.findIndex((read) => read.key === key);
        return index === -1 ? INPUT_OPTIONS_LOADING : snapshot[index] ?? INPUT_OPTIONS_LOADING;
    }, [activeReads, keys, defaultContexts, snapshot]);
    const retry = React.useCallback(() => activeReads.forEach(retryInputFieldOptions), [activeReads]);
    const pickerContextKey = JSON.stringify([signature, snapshot, params.requests[0]?.draftInput]);
    const resolveOptions: ResolveSessionActionFieldOptions = React.useMemo(() => Object.assign(
        (field: Parameters<ResolveSessionActionFieldOptions>[0], context?: InputFieldOptionsContext) => state({ ...field, path: field.path ?? '' }, context).options,
        { state, retry, pickerContext: { machineId, sessionId: params.sessionId,
            draftInput: params.requests[0]?.draftInput,
            ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
            serverId: params.serverId ?? accountScope?.serverId,
            contextKey: pickerContextKey } },
    ), [state, retry, signature, snapshot, pickerContextKey, params.accountLifetime]);
    return { resolveOptions, state, retry, snapshot };
}
