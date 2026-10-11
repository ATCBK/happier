import * as React from 'react';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createManagedProvisionerClient } from './managedProvisionerClient';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** Demand belongs to the mounted Create surface, and all data retires with its exact Home credential. */
export function useManagedProvisioners(serverId: string, onApprovalPending?: (registration: ActionApprovalRegistration) => void,
    controller?: ManagedControllerV1 | readonly ManagedControllerV1[]) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const homeId = getServerProfileById(serverId)?.serverIdentityId?.trim() || null;
    const [state, setState] = React.useState<Readonly<{
        binding: ServerCredentialAccountScopeBinding | null; requestKey: string; provisioners: MachineProvisionersListResultV1['provisioners'];
        error: string | null; loading: boolean;
    }>>({ binding: null, requestKey: '', provisioners: [], error: null, loading: false });
    const controllers = React.useMemo(() => controller ? 'machineId' in controller ? [controller] : controller : [], [controller]);
    const requestKey = JSON.stringify([homeId, controllers]);
    // Presence projections may recreate equivalent controller objects. Only the semantic
    // request key changes demand; the ref supplies that render's typed inputs to the effect.
    const controllersRef = React.useRef(controllers);
    controllersRef.current = controllers;
    const [refreshRevision, refresh] = React.useReducer(value => value + 1, 0);
    const approvalRef = React.useRef(onApprovalPending);
    approvalRef.current = onApprovalPending;
    const client = React.useMemo(() => binding && homeId ? createManagedProvisionerClient(binding.scope, homeId) : null, [binding, homeId]);
    React.useEffect(() => {
        const selectedControllers = controllersRef.current;
        if (!binding || !client || !homeId || selectedControllers.length === 0) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState(current => current.binding === binding ? { binding: null, requestKey: '', provisioners: [], error: null, loading: false } : current);
        });
        setState(current => ({ binding, requestKey, provisioners: current.binding === binding && current.requestKey === requestKey ? current.provisioners : [], error: null, loading: true }));
        // Each controller answers for its own installs, as soon as it answers: one that is slow, cannot answer or
        // fails does not hold back or hide the others'. Until one answers, the last-known list stays.
        type Settled = { kind: 'succeeded'; provisioners: MachineProvisionersListResultV1['provisioners'] } | { kind: 'failed'; code: string };
        const settled: (Settled | undefined)[] = selectedControllers.map(() => undefined);
        const publish = () => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            const answered = settled.filter(result => result?.kind === 'succeeded');
            const done = settled.every(result => result !== undefined);
            const failure = settled.find(result => result?.kind === 'failed');
            setState(current => current.binding !== binding || current.requestKey !== requestKey ? current : {
                ...current, loading: !done,
                provisioners: answered.length > 0 ? settled.flatMap(result => result?.kind === 'succeeded' ? result.provisioners : []) : current.provisioners,
                error: done && answered.length === 0 && failure?.kind === 'failed' ? failure.code : null,
            });
        };
        selectedControllers.forEach((selected, index) => {
            void client.read('machines.provisioners.list', { homeId, controller: selected },
                { signal: abort.signal, onApprovalPending: registration => approvalRef.current?.(registration) }).then(result => {
                settled[index] = result.kind === 'succeeded' ? { kind: 'succeeded', provisioners: result.value.provisioners }
                    : { kind: 'failed', code: result.code };
                publish();
            }, () => {
                settled[index] = { kind: 'failed', code: 'unavailable' };
                publish();
            });
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, client, homeId, requestKey, refreshRevision]);
    const visible = binding?.isCurrent() && state.binding === binding && state.requestKey === requestKey ? state : {
        provisioners: [], error: resolution.kind === 'resolving' || resolution.kind === 'bound' ? null : resolution.kind,
        loading: resolution.kind === 'resolving' || resolution.kind === 'bound' && controllers.length > 0,
    };
    return { binding, resolution, homeId, client, provisioners: visible.provisioners,
        error: binding && !homeId ? 'unsupported_action' : visible.error,
        loading: binding && !homeId ? false : visible.loading, refresh };
}
