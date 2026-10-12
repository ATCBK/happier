import * as React from 'react';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { useAccountSettingsScope } from './settingsWriters';
import { usePromptLibraryCatalogValue } from './usePromptLibraryCatalog';
import { getMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots } from './settings/mcpServerCatalogSnapshot';
import { observeMcpServerCatalog } from '@/sync/engine/settings/mcpServerCatalogEngine';

const emptyRules: ReachRulesV1 = Object.freeze([]);

/** Select one item's rules from its existing Account row; only the selected catalog is demanded. */
export function useReachRulesCatalog(kind: 'skill' | 'mcp_server', itemId: string) {
    const activeScope = useAccountSettingsScope();
    const serverId = activeScope?.serverId;
    const accountId = activeScope?.accountId;
    const scope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const mcpScope = kind === 'mcp_server' ? scope : null;
    React.useEffect(() => mcpScope ? observeMcpServerCatalog(mcpScope) : undefined, [mcpScope]);
    const readMcp = React.useCallback(() => getMcpServerCatalogSnapshot(mcpScope), [mcpScope]);
    const subscribeMcp = React.useCallback((listener: () => void) => mcpScope
        ? subscribeMcpServerCatalogSnapshots(listener) : () => {}, [mcpScope]);
    const mcp = React.useSyncExternalStore(subscribeMcp, readMcp, readMcp);
    const skills = usePromptLibraryCatalogValue('skill-rules', kind === 'skill' ? scope : null);
    const value = kind === 'skill' ? skills : mcp;
    const rules = React.useMemo<ReachRulesV1>(() => kind === 'skill'
        ? skills.value?.rules.filter(rule => rule.skillId === itemId).map(({ skillId: _skillId, ...rule }) => rule) ?? emptyRules
        : mcp.value?.bindings.filter(rule => rule.serverId === itemId).map(({ serverId: _serverId, ...rule }) => rule) ?? emptyRules,
    [kind, skills.value, mcp.value, itemId]);
    const writable = value.status === 'ready' && !value.stale && value.revision !== 'absent'
        && (kind === 'skill' || mcp.authority === 'active');
    const status = writable ? 'ready' as const : value.status === 'loading' ? 'loading' as const : 'unavailable' as const;
    return { scope, rules, status, revision: value.revision, valueAvailable: value.value !== null };
}
