import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { WorkflowTriggerUpdateRequestV1Schema, type SessionTriggerAddRequestV1, type SessionTriggerUpdateRequestV1, type SessionTriggerPullRequestLinksV1, type WorkflowTriggerSetV1 } from '@happier-dev/protocol';

import { getStorage, useActiveServerAccountScopeLifetime, useSessionMachineId } from '@/sync/domains/state/storage';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { watchActivePluginCollectionChanges } from '@/sync/api/plugins/data/pluginCollectionChangeWatch';
import { createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector } from '@/sync/store/domains/automations';
import {
    addSessionTrigger,
    listSessionTriggers,
    removeSessionTrigger,
    updateSessionTrigger,
    updateWorkflowTrigger,
    removeWorkflowTrigger,
    type WorkflowTriggerWriteResult,
} from '@/sync/domains/workflows/workflowTriggerActions';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

const ACCOUNT_TRIGGERS = { scope: 'account_all' } as const;

export type SessionTriggersRead = Readonly<{
    status: 'loading' | 'ready' | 'failed';
    /** The last sets the owner returned; kept while a refresh or a failed read is pending. */
    sets: readonly WorkflowTriggerSetV1[];
    lastRunAtByAutomationId: Readonly<Record<string, number | null>>;
    /** The session's Machine, used for native capability observations and Action options. */
    machineId: string | null;
    pullRequestLinks: SessionTriggerPullRequestLinksV1 | Readonly<{ status: 'loading' }>;
    retry: () => void;
    add: (request: Omit<SessionTriggerAddRequestV1, 'sessionId'>) => Promise<WorkflowTriggerWriteResult>;
    update: (request: Omit<SessionTriggerUpdateRequestV1, 'sessionId'>) => Promise<WorkflowTriggerWriteResult>;
    remove: (triggerId: string) => Promise<WorkflowTriggerWriteResult>;
}>;

/**
 * Session Habits combine scoped triggers and Account triggers whose accepted graph targets this
 * Session through the shared set selector. Each keeps its existing Action mutation authority;
 * displaying an Account Habit here never changes its scope or execution placement.
 *
 * The Account's Automation projection is only a change signal here: when the session's scoped rows
 * change (an agent added a trigger, a run finished) the list is read again; its `lastRunAt` gives
 * each row its last outcome.
 */
export function useSessionTriggers(sessionId: string): SessionTriggersRead {
    const accountLifetime = useActiveServerAccountScopeLifetime();
    // The Work shell can mount from a list row before its owner metadata arrives.
    // Retry the same Account read when either owner routing fact hydrates.
    const sessionMachineId = useSessionMachineId(sessionId);
    const sessionDirectory = getStorage()((state) => {
        const session = state.sessions[sessionId];
        return session ? readSessionOwnerMetadataView(session)?.path?.trim() ?? null : null;
    });
    const scope = accountLifetime?.scope ?? null;
    const linkScopeKey = scope ? serverAccountScopedResourceKey(scope, sessionId) : null;
    const selector = React.useMemo(() => createWorkflowTriggerSetSelector(`session:${sessionId}`), [sessionId]);
    const sets = getStorage()(selector);
    const accountRead = useWorkflowTriggerSets(ACCOUNT_TRIGGERS);
    const changeSelector = React.useMemo(() => createWorkflowTriggerChangeSelector(sessionId), [sessionId]);
    const changeSignal = getStorage()(changeSelector);
    const lastRunAtByAutomationId = getStorage()(useShallow((state) => Object.fromEntries(
        sets.map((set) => [set.automationId, state.automations[set.automationId]?.lastRunAt ?? null]),
    )));

    const [state, setState] = React.useState<Readonly<{ scopeKey: string | null; status: SessionTriggersRead['status'] }>>(
        () => ({ scopeKey: linkScopeKey, status: 'loading' }),
    );
    const [attempt, setAttempt] = React.useState(0);
    const [links, setLinks] = React.useState<Readonly<{ scopeKey: string | null; value: SessionTriggersRead['pullRequestLinks'] }>>(
        () => ({ scopeKey: linkScopeKey, value: { status: 'loading' } }),
    );
    const options = React.useCallback((scopeSessionId = sessionId) => {
        const machineId = readMachineControlTargetForSession(scopeSessionId)?.machineId;
        return machineId ? { context: { externalActionTarget: { kind: 'machine' as const, machineId } } } : {};
    }, [sessionId]);

    React.useEffect(() => {
        if (linkScopeKey === null) return;
        if (!accountLifetime) return;
        const watch = watchActivePluginCollectionChanges({
            pluginId: 'happier.channels', collectionId: 'channel-state', accountLifetime,
            onInvalidated: () => setAttempt((value) => value + 1),
        });
        return () => watch?.dispose();
    }, [accountLifetime, linkScopeKey]);

    React.useEffect(() => {
        if (!accountLifetime) return;
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        setState((current) => (current.scopeKey === linkScopeKey ? current : { scopeKey: linkScopeKey, status: 'loading' }));
        listSessionTriggers({ sessionId }, { ...options(), signal: controller.signal })
            .then((result) => {
                if (!controller.signal.aborted && accountLifetime.isCurrent()) {
                    setLinks({ scopeKey: linkScopeKey, value: result.pullRequestLinks });
                    setState({ scopeKey: linkScopeKey, status: 'ready' });
                }
            })
            .catch(() => {
                if (!controller.signal.aborted && accountLifetime.isCurrent()) setState({ scopeKey: linkScopeKey, status: 'failed' });
            });
        return () => { controller.abort(); retirement.dispose(); };
    }, [accountLifetime, attempt, changeSignal, linkScopeKey, options, sessionDirectory, sessionId, sessionMachineId]);

    const applyWrite = React.useCallback((result: WorkflowTriggerWriteResult) => {
        setAttempt((value) => value + 1);
        setState((current) => (current.scopeKey === linkScopeKey
            ? { ...current, status: 'ready' }
            : current));
        return result;
    }, [linkScopeKey]);

    const add = React.useCallback<SessionTriggersRead['add']>(
        async (request) => applyWrite(await addSessionTrigger({ ...request, sessionId }, options())),
        [applyWrite, options, sessionId],
    );
    const update = React.useCallback<SessionTriggersRead['update']>(
        async (request) => {
            const set = sets.find((set) => set.triggers.some((trigger) => trigger.id === request.triggerId));
            const scopeSessionId = set?.scopeSessionId ?? sessionId;
            return applyWrite(await (set && !set.scopeSessionId
                ? updateWorkflowTrigger(WorkflowTriggerUpdateRequestV1Schema.parse({ ...request, automationId: set.automationId }))
                : updateSessionTrigger({ ...request, sessionId: scopeSessionId }, options(scopeSessionId))));
        },
        [applyWrite, options, sessionId, sets],
    );
    const remove = React.useCallback<SessionTriggersRead['remove']>(
        async (triggerId) => {
            const set = sets.find((set) => set.triggers.some((trigger) => trigger.id === triggerId));
            const scopeSessionId = set?.scopeSessionId ?? sessionId;
            return applyWrite(await (set && !set.scopeSessionId
                ? removeWorkflowTrigger({ automationId: set.automationId, triggerId })
                : removeSessionTrigger({ sessionId: scopeSessionId, triggerId }, options(scopeSessionId))));
        },
        [applyWrite, options, sessionId, sets],
    );
    const retry = React.useCallback(() => { setAttempt((value) => value + 1); accountRead.retry(); }, [accountRead.retry]);

    const owned = linkScopeKey !== null && state.scopeKey === linkScopeKey;
    return {
        machineId: readMachineControlTargetForSession(sessionId)?.machineId ?? null,
        pullRequestLinks: linkScopeKey !== null && links.scopeKey === linkScopeKey ? links.value : { status: 'loading' },
        status: !owned || state.status === 'loading' || accountRead.status === 'loading' ? 'loading'
            : state.status === 'failed' || accountRead.status === 'failed' ? 'failed' : 'ready',
        sets,
        lastRunAtByAutomationId,
        retry,
        add,
        update,
        remove,
    };
}
