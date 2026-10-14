import * as React from 'react';
import {
    ensureMachineAgentInstallJobs, readAgentInstallJob, subscribeAgentInstallJob,
    type AgentInstallJobTarget, type AgentInstallJobStartOptions,
} from './installJobStore';
import type { AgentInstallJobIntent } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { AgentInstallJobRpcError } from './api';

export function useAgentInstallJob({ serverId, machineId, agentId, definitionId }: Omit<AgentInstallJobTarget, 'accountId'>) {
    const { binding, execute } = useMountedActionExecution(serverId);
    const target = React.useMemo(() => binding?.isCurrent() ? { ...binding.scope, machineId, agentId, definitionId } : null, [binding, machineId, agentId, definitionId]);
    const subscribe = React.useCallback((listener: () => void) => target ? subscribeAgentInstallJob(target, listener) : () => {}, [target]);
    const read = React.useCallback(() => target && binding?.isCurrent() ? readAgentInstallJob(target) : null, [binding, target]);
    const job = React.useSyncExternalStore(subscribe, read, read);
    React.useEffect(() => {
        if (target && machineId) void ensureMachineAgentInstallJobs(target).catch(() => {});
    }, [target, machineId]);
    const start = React.useCallback((intent: AgentInstallJobIntent, options: Pick<AgentInstallJobStartOptions, 'consent' | 'force'>) => {
        if (!target || !binding?.isCurrent()) return Promise.reject(new AgentInstallJobRpcError('scope_retired'));
        return execute(intent === 'uninstall' ? 'machines.agents.uninstall' : 'machines.agents.install', {
            machineId, agentId, ...(definitionId === undefined ? {} : { definitionId }),
            ...(intent === 'uninstall' ? {} : { intent, ...options }),
        });
    }, [agentId, binding, definitionId, execute, machineId, target]);
    const cancel = React.useCallback(() => {
        if (!target || !binding?.isCurrent()) return Promise.reject(new AgentInstallJobRpcError('scope_retired'));
        const current = readAgentInstallJob(target);
        return current && !current.outcome ? execute('machines.agents.install.cancel', { machineId, jobId: current.jobId }) : Promise.resolve();
    }, [binding, execute, machineId, target]);
    return { job, start, cancel };
}
