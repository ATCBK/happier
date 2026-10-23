import * as React from 'react';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { useAccountSettingsScope } from './settingsWriters';
import { usePromptLibraryCatalogValue } from './usePromptLibraryCatalog';
import { getMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots } from './settings/mcpServerCatalogSnapshot';
import { observeMcpServerCatalog } from '@/sync/engine/settings/mcpServerCatalogEngine';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getAcknowledgedPromptLibraryCatalogValue } from './settings/promptLibraryCatalogSnapshot';

const emptyRules: ReachRulesV1 = Object.freeze([]);
type SkillRulesValue = ReturnType<typeof usePromptLibraryCatalogValue<'skill-rules'>>['value'];

/** Project the Account row once, rather than filtering it for every sheet row and render. */
function indexReachRules(rows: SkillRulesValue | McpServerCatalogV1 | null) {
    const byItem = new Map<string, ReachRulesV1[number][]>();
    if (rows) {
        const entries = 'rules' in rows
            ? rows.rules.map(({ skillId, ...rule }) => [skillId, rule] as const)
            : rows.bindings.map(({ serverId, ...rule }) => [serverId, rule] as const);
        for (const [id, rule] of entries) {
            const rules = byItem.get(id);
            if (rules) rules.push(rule); else byItem.set(id, [rule]);
        }
    }
    return byItem;
}

/** One item's rules out of the two Account rows that hold them (skills: `skill-rules`; MCP servers: the catalog's bindings). */
function selectReachRules(kind: 'skill' | 'mcp_server', itemId: string,
    rows: Readonly<{ skillRules: SkillRulesValue | null | undefined; mcp: McpServerCatalogV1 | null | undefined }>): ReachRulesV1 {
    return kind === 'skill'
        ? rows.skillRules?.rules.filter(rule => rule.skillId === itemId).map(({ skillId: _skillId, ...rule }) => rule) ?? emptyRules
        : rows.mcp?.bindings.filter(rule => rule.serverId === itemId).map(({ serverId: _serverId, ...rule }) => rule) ?? emptyRules;
}

/**
 * Every item's rules for one Account at once (the session sheet lists many items): the same two rows and
 * the same selection as `useReachRulesCatalog`, plus the MCP catalog the rows' statuses read.
 */
export function useReachRulesLookup(requestedScope?: ServerAccountScope | null) {
    const activeScope = useAccountSettingsScope();
    const selectedScope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = selectedScope?.serverId;
    const accountId = selectedScope?.accountId;
    const scope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    React.useEffect(() => scope ? observeMcpServerCatalog(scope) : undefined, [scope]);
    const readMcp = React.useCallback(() => getMcpServerCatalogSnapshot(scope), [scope]);
    const subscribeMcp = React.useCallback((listener: () => void) => scope
        ? subscribeMcpServerCatalogSnapshots(listener) : () => {}, [scope]);
    const mcp = React.useSyncExternalStore(subscribeMcp, readMcp, readMcp);
    const skills = usePromptLibraryCatalogValue('skill-rules', scope);
    const skillRulesByItem = React.useMemo(() => indexReachRules(skills.value), [skills.value]);
    const mcpRulesByItem = React.useMemo(() => indexReachRules(mcp.value), [mcp.value]);
    const rules = React.useCallback((kind: 'skill' | 'mcp_server', itemId: string) =>
        (kind === 'skill' ? skills.value : mcp.value) === null ? null
            : (kind === 'skill' ? skillRulesByItem : mcpRulesByItem).get(itemId) ?? emptyRules,
        [skills.value, mcp.value, skillRulesByItem, mcpRulesByItem]);
    return React.useMemo(() => ({ scope, rules, skillRules: skills.value, mcpCatalog: mcp.value }), [scope, rules, skills.value, mcp.value]);
}

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
    const rules = React.useMemo<ReachRulesV1>(() => selectReachRules(kind, itemId, { skillRules: skills.value, mcp: mcp.value }),
    [kind, skills.value, mcp.value, itemId]);
    const writable = value.status === 'ready' && !value.stale && value.revision !== 'absent'
        && (kind === 'skill' || mcp.authority === 'active');
    const status = writable ? 'ready' as const : value.status === 'loading' ? 'loading' as const : 'unavailable' as const;
    const acknowledgedRules = React.useMemo<ReachRulesV1>(() => kind === 'skill'
        ? selectReachRules(kind, itemId, { skillRules: acknowledgedSkills.value, mcp: null })
        : rules, [kind, acknowledgedSkills.value, itemId, rules]);
    return { scope, rules, acknowledgedRules, status, revision: value.revision, valueAvailable: value.value !== null };
}
