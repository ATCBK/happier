import type { McpServerCatalogEntryV1, McpServerConfigOverrideFieldsV1, McpValueRefV1 } from './settingsV1.js';
import { resolveReachV1, type ReachContextV1 } from '../../reach/resolveReachV1.js';

function patchValues(base: Record<string, McpValueRefV1>, patch?: Record<string, McpValueRefV1 | null>): Record<string, McpValueRefV1> {
  if (!patch) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}

/** Configuration never reads or writes reach enablement. */
export function applyMcpServerConfigOverrideV1(server: McpServerCatalogEntryV1, override?: McpServerConfigOverrideFieldsV1): McpServerCatalogEntryV1 {
  if (!override) return server;
  return { ...server,
    ...(override.envPatch ? { env: patchValues(server.env, override.envPatch) } : {}),
    ...(server.stdio && override.stdio ? { stdio: { ...server.stdio, ...override.stdio } } : {}),
    ...(server.remote && override.remote ? { remote: { ...server.remote,
      ...(override.remote.url !== undefined ? { url: override.remote.url } : {}),
      ...(override.remote.headersPatch ? { headers: patchValues(server.remote.headers, override.remote.headersPatch) } : {}),
    } } : {}),
  };
}

export function resolveMcpServerConfigForContextV1(server: McpServerCatalogEntryV1, context: ReachContextV1): McpServerCatalogEntryV1 {
  const overrides = server.configOverrides ?? [];
  const { configOverrides: _configOverrides, ...base } = server;
  const decision = resolveReachV1(overrides.map((override, index) => ({ id: String(index), target: override.target,
    enabled: true, createdAt: 0, updatedAt: index })), context);
  return decision.decidedBy === null ? base : applyMcpServerConfigOverrideV1(base, overrides[Number(decision.decidedBy.ruleId)]);
}
