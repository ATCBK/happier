import * as React from 'react';
import {
    cancelAgentInstallJob, ensureMachineAgentInstallJobs, readAgentInstallJob,
    startAgentInstallJob, subscribeAgentInstallJob,
    type AgentInstallJobTarget, type AgentInstallJobStartOptions,
} from './installJobStore';
import type { AgentInstallJobIntent } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { AgentInstallJobRpcError } from './api';

export function useAgentInstallJob({ serverId, machineId, agentId, definitionId }: Omit<AgentInstallJobTarget, 'accountId'>) {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const target = React.useMemo(() => binding?.isCurrent() ? { ...binding.scope, machineId, agentId, definitionId } : null, [binding, machineId, agentId, definitionId]);
    const subscribe = React.useCallback((listener: () => void) => target ? subscribeAgentInstallJob(target, listener) : () => {}, [target]);
    const read = React.useCallback(() => target && binding?.isCurrent() ? readAgentInstallJob(target) : null, [binding, target]);
    const job = React.useSyncExternalStore(subscribe, read, read);
    React.useEffect(() => {
        if (target && machineId) void ensureMachineAgentInstallJobs(target).catch(() => {});
    }, [target, machineId]);
    const start = React.useCallback((intent: AgentInstallJobIntent, options: AgentInstallJobStartOptions) => target && binding?.isCurrent()
        ? startAgentInstallJob(target, intent, options) : Promise.reject(new AgentInstallJobRpcError('scope_retired')), [binding, target]);
    const cancel = React.useCallback(() => target && binding?.isCurrent()
        ? cancelAgentInstallJob(target) : Promise.reject(new AgentInstallJobRpcError('scope_retired')), [binding, target]);
    return { job, start, cancel };
}
