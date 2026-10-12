import * as React from 'react';
import { useReachRulesCatalog } from '@/sync/store/useReachRulesCatalog';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useReachRulesState, type ExecuteReachRules } from './useReachRulesState';

export type { ReachRulesWriteResult } from './useReachRulesState';
export function useReachRules(kind: 'skill' | 'mcp_server', itemId: string) {
    const catalog = useReachRulesCatalog(kind, itemId);
    const execution = useMountedActionExecution(catalog.scope);
    const execute = React.useCallback<ExecuteReachRules>((actionId, input) => execution.execute(actionId, input), [execution.execute]);
    return useReachRulesState({ key: JSON.stringify([catalog.scope?.serverId, catalog.scope?.accountId, kind, itemId]),
        kind, itemId, rules: catalog.rules, status: catalog.status, revision: catalog.revision, valueAvailable: catalog.valueAvailable }, execute);
}
