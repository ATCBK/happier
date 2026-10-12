import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { normalizeReachRulesV1 } from '../../reach/reachRulesChangeV1.js';
import { applyMcpServerConfigOverrideV1 } from './resolveMcpServerConfigForContextV1.js';
import type { McpServerCatalogEntryV1, McpServerRuleV1, McpServerConfigOverrideFieldsV1, McpServerConfigOverrideV1 } from './settingsV1.js';
import type { ValueRefV1 } from '../../valueRefs/valueRefV1.js';

type RetainedRule = McpServerRuleV1 & { overrides?: McpServerConfigOverrideFieldsV1 };

function valuePatch(base: Record<string, ValueRefV1>, desired: Record<string, ValueRefV1>): Record<string, ValueRefV1 | null> | undefined {
  const patch: Record<string, ValueRefV1 | null> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
    if (!sameStrictJsonValue(base[key] ?? null, desired[key] ?? null)) patch[key] = desired[key] ?? null;
  }
  return Object.keys(patch).length ? patch : undefined;
}

function difference(base: McpServerCatalogEntryV1, desired: McpServerCatalogEntryV1): McpServerConfigOverrideFieldsV1 {
  const envPatch = valuePatch(base.env, desired.env);
  const result: McpServerConfigOverrideFieldsV1 = envPatch ? { envPatch } : {};
  if (base.stdio && desired.stdio) {
    const command = base.stdio.command !== desired.stdio.command ? desired.stdio.command : undefined;
    const args = !sameStrictJsonValue(base.stdio.args, desired.stdio.args) ? desired.stdio.args : undefined;
    if (command !== undefined || args !== undefined) result.stdio = { ...(command !== undefined ? { command } : {}), ...(args !== undefined ? { args } : {}) };
  }
  if (base.remote && desired.remote) {
    const url = base.remote.url !== desired.remote.url ? desired.remote.url : undefined;
    const headersPatch = valuePatch(base.remote.headers, desired.remote.headers);
    if (url !== undefined || headersPatch) result.remote = { ...(url !== undefined ? { url } : {}), ...(headersPatch ? { headersPatch } : {}) };
  }
  return result;
}

/** 0.2 applied only its winning binding to the original base, never a layered override. */
export function splitRetainedMcpServerConfigurationV1(servers: readonly McpServerCatalogEntryV1[], bindings: readonly RetainedRule[]):
  Readonly<{ servers: McpServerCatalogEntryV1[]; bindings: McpServerRuleV1[] }> {
  const normalized = servers.flatMap(server => normalizeReachRulesV1(bindings.filter(rule => rule.serverId === server.id)));
  return { servers: servers.map(original => {
    const rules = normalized.filter(rule => rule.serverId === original.id);
    const everywhere = rules.find(rule => rule.target.t === 'allMachines');
    const folded = applyMcpServerConfigOverrideV1(original, everywhere?.overrides);
    const configOverrides: McpServerConfigOverrideV1[] = rules.flatMap(rule => {
      if (rule.target.t !== 'machine' && rule.target.t !== 'workspace') return [];
      const compensating = difference(folded, applyMcpServerConfigOverrideV1(original, rule.overrides));
      const own = rule.overrides;
      return [{ target: rule.target, ...compensating, ...own,
        ...(compensating.envPatch || own?.envPatch ? { envPatch: { ...compensating.envPatch, ...own?.envPatch } } : {}),
        ...(compensating.stdio || own?.stdio ? { stdio: { ...compensating.stdio, ...own?.stdio } } : {}),
        ...(compensating.remote || own?.remote ? { remote: { ...compensating.remote, ...own?.remote,
          ...(compensating.remote?.headersPatch || own?.remote?.headersPatch ? { headersPatch: { ...compensating.remote?.headersPatch, ...own?.remote?.headersPatch } } : {}),
        } } : {}),
      }];
    });
    // Even an empty narrower row matters: it prevents a broader machine override
    // from leaking into a workspace whose predecessor winner had no overrides.
    return configOverrides.length ? { ...folded, configOverrides } : folded;
  }), bindings: normalized.map(({ overrides: _overrides, ...rule }) => rule) };
}
