import {
  resolveAcpToolPermissionPolicy,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentPermissionIntent, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

type OpenCodePermissionPolicy = ReturnType<typeof resolveAcpToolPermissionPolicy>;

export const KILO_PERMISSION_ENV = 'KILO_PERMISSION';

export function sanitizeKiloMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function resolveKiloOpenCodePermissionPolicy(permissionIntent: AgentPermissionIntent | null): OpenCodePermissionPolicy {
  return resolveAcpToolPermissionPolicy(permissionIntent);
}

export function buildKiloOpenCodePermissionEnv(params: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  permissionIntent: AgentPermissionIntent | null;
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
}>): Readonly<Record<string, string>> {
  if (
    typeof params.env?.[KILO_PERMISSION_ENV] === 'string'
    && params.env[KILO_PERMISSION_ENV].length > 0
    && params.mcpToolPolicy === undefined
  ) {
    return {};
  }
  const ambient: unknown = params.env?.[KILO_PERMISSION_ENV] ? JSON.parse(params.env[KILO_PERMISSION_ENV]) : {};
  if (ambient === null || typeof ambient !== 'object' || Array.isArray(ambient)) throw new Error('Kilo permission environment must contain an object');
  const inherited = params.env?.[KILO_PERMISSION_ENV]
    ? ambient
    : resolveKiloOpenCodePermissionPolicy(params.permissionIntent);
  const mcpRules = Object.fromEntries(Object.entries(params.mcpToolPolicy ?? {}).filter(([server]) => server !== 'happier').flatMap(([server, entry]) => {
      const alias = sanitizeKiloMcpName(server);
      // Native Allow must remain revocable through the live host permission owner.
      const action = (value: 'off' | 'allow' | 'ask' | 'deny') => value === 'off' || value === 'deny' ? 'deny' : 'ask';
      const tools = new Map<string, 'deny' | 'ask'>();
      for (const [tool, value] of Object.entries(entry.tools)) {
        const name = `${alias}_${sanitizeKiloMcpName(tool)}`;
        tools.set(name, tools.has(name) ? 'deny' : action(value));
      }
      return [[`${alias}_*`, action(entry.unlisted)], ...tools];
    }));
  const policy = Object.fromEntries([
    ...Object.entries(inherited).filter(([key]) => !Object.prototype.hasOwnProperty.call(mcpRules, key)),
    ...Object.entries(mcpRules),
  ]);
  return { [KILO_PERMISSION_ENV]: JSON.stringify(policy) };
}
