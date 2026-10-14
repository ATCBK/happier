import { createHash } from 'node:crypto';
import type { AgentSessionMcpLaunchConfig, AgentSessionMcpService } from '@happier-dev/plugin-sdk/agents/runtime';

// This marker cannot be a pass-through name, so original names cannot shadow aliases.
const ALIAS_PREFIX = 'h__';

export function isMcpToolNameAlias(name: string): boolean {
  return name.startsWith(ALIAS_PREFIX);
}

export function projectMcpToolNames(
  names: readonly string[],
  toolNameMaxLength?: number,
): readonly Readonly<{ originalName: string; projectedName: string }>[] {
  if (toolNameMaxLength !== undefined && (!Number.isSafeInteger(toolNameMaxLength) || toolNameMaxLength <= ALIAS_PREFIX.length)) {
    throw new Error('MCP tool-name budget cannot hold a transport alias');
  }
  const originalsByAlias = new Map<string, string>();
  return names.map(originalName => {
    const projectedName = toolNameMaxLength === undefined
      || (originalName.length <= toolNameMaxLength && /^[A-Za-z0-9_-]+$/.test(originalName) && !isMcpToolNameAlias(originalName))
      ? originalName
      : `${ALIAS_PREFIX}${createHash('sha256').update(originalName).digest('hex').slice(0, toolNameMaxLength - ALIAS_PREFIX.length)}`;
    const prior = originalsByAlias.get(projectedName);
    if (prior !== undefined && prior !== originalName) throw new Error('MCP transport tool-name alias collision');
    originalsByAlias.set(projectedName, originalName);
    return { originalName, projectedName };
  });
}

/** A fresh read from the admitted inventory, with naming scoped to the returned stdio launch. */
export function createHappierMcpToolNamingResolver(
  launchConfig: AgentSessionMcpLaunchConfig,
  readToolNames: (signal?: AbortSignal) => Promise<readonly string[]>,
): NonNullable<AgentSessionMcpService['resolveToolNaming']> {
  return async (request, options) => {
    if (request.serverName !== 'happier') return null;
    options?.signal?.throwIfAborted();
    const tools = projectMcpToolNames(await readToolNames(options?.signal), request.toolNameMaxLength);
    options?.signal?.throwIfAborted();
    return {
      aliasPrefix: ALIAS_PREFIX,
      launchConfig: {
        ...launchConfig,
        args: [...(launchConfig.args ?? []), '--tool-name-max-length', String(request.toolNameMaxLength)],
      },
      tools,
    };
  };
}
