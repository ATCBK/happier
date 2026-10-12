import * as React from 'react';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { useMcpServersSettings } from '@/components/settings/mcpServers/useMcpServersSettings';
import { useReachRulesState, type ExecuteReachRules } from './useReachRulesState';

export type { ReachRulesWriteResult } from './useReachRulesState';
export function useReachRules(kind: 'skill' | 'mcp_server', itemId: string) {
    const catalog = useMcpServersSettings();
    const rules: ReachRulesV1 = React.useMemo(() => catalog.settings.bindings.filter(rule => rule.serverId === itemId)
        .map(({ serverId: _serverId, ...rule }) => rule), [catalog.settings.bindings, itemId]);
    const status = kind === 'mcp_server' && catalog.writable ? 'ready' as const
        : catalog.snapshot.status === 'loading' ? 'loading' as const : 'unavailable' as const;
    const execute = React.useCallback<ExecuteReachRules>((_actionId, input) => catalog.executeRules({ ...input, items: [...input.items] }), [catalog.executeRules]);
    return useReachRulesState({ key: JSON.stringify([catalog.scope?.serverId, catalog.scope?.accountId, kind, itemId]),
        itemId, rules, status, revision: catalog.snapshot.revision, valueAvailable: catalog.snapshot.value !== null }, execute);
}
