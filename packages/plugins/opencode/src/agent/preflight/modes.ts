import type { OpenCodeServerClient } from '../runtime/server/openCodeServerClient.js';
import type { OpenCodeModeCatalogSnapshot } from '../runtime/server/operations.js';

/** Native Session admission and preflight expose the same Agent inventory. */
export function buildOpenCodeModesFromAgents(agents: Awaited<ReturnType<OpenCodeServerClient['agentsList']>>): NonNullable<OpenCodeModeCatalogSnapshot['modes']> {
  return agents.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) }));
}
