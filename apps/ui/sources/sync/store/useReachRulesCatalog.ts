import * as React from 'react';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { useAccountSettingsScope } from './settingsWriters';
import { usePromptLibraryCatalogValue } from './usePromptLibraryCatalog';
import { getMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots } from './settings/mcpServerCatalogSnapshot';
import { observeMcpServerCatalog } from '@/sync/engine/settings/mcpServerCatalogEngine';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getAcknowledgedPromptLibraryCatalogValue } from './settings/promptLibraryCatalogSnapshot';

const emptyRules: ReachRulesV1 = Object.freeze([]);

/** Select one item's rules from its existing Account row; only the selected catalog is demanded. */
export function useReachRulesCatalog(kind: 'skill' | 'mcp_server', itemId: string, requestedScope?: ServerAccountScope | null) {
    const activeScope = useAccountSettingsScope();
    const selectedScope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = selectedScope?.serverId;
    const accountId = selectedScope?.accountId;
    const scope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const mcpScope = kind === 'mcp_server' ? scope : null;
    React.useEffect(() => mcpScope ? observeMcpServerCatalog(mcpScope) : undefined, [mcpScope]);
    const readMcp = React.useCallback(() => getMcpServerCatalogSnapshot(mcpScope), [mcpScope]);
    const subscribeMcp = React.useCallback((listener: () => void) => mcpScope
        ? subscribeMcpServerCatalogSnapshots(listener) : () => {}, [mcpScope]);
    const mcp = React.useSyncExternalStore(subscribeMcp, readMcp, readMcp);
    const skills = usePromptLibraryCatalogValue('skill-rules', kind === 'skill' ? scope : null);
    const acknowledgedSkills = getAcknowledgedPromptLibraryCatalogValue(scope, 'skill-rules');
    const value = kind === 'skill' ? skills : mcp;
    const rules = React.useMemo<ReachRulesV1>(() => kind === 'skill'
        ? skills.value?.rules.filter(rule => rule.skillId === itemId).map(({ skillId: _skillId, ...rule }) => rule) ?? emptyRules
        : mcp.value?.bindings.filter(rule => rule.serverId === itemId).map(({ serverId: _serverId, ...rule }) => rule) ?? emptyRules,
    [kind, skills.value, mcp.value, itemId]);
    const writable = value.status === 'ready' && !value.stale && value.revision !== 'absent'
        && (kind === 'skill' || mcp.authority === 'active');
    const status = writable ? 'ready' as const : value.status === 'loading' ? 'loading' as const : 'unavailable' as const;
    const acknowledgedRules = React.useMemo<ReachRulesV1>(() => kind === 'skill'
        ? acknowledgedSkills.value?.rules.filter(rule => rule.skillId === itemId).map(({ skillId: _skillId, ...rule }) => rule) ?? emptyRules
        : rules, [kind, acknowledgedSkills.value, itemId, rules]);
    return { scope, rules, acknowledgedRules, status, revision: value.revision, valueAvailable: value.value !== null };
}
