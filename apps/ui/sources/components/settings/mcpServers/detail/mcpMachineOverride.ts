import {
  McpServerConfigOverrideFieldsV1Schema,
  type McpServerCatalogEntryV1,
  type McpServerConfigOverrideFieldsV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** What one value map changes: new and changed entries as themselves, entries the machine lacks as `null`. */
function patchBetween(
  base: Readonly<Record<string, ValueRefV1>>,
  edited: Readonly<Record<string, ValueRefV1>>,
): Record<string, ValueRefV1 | null> | undefined {
  const patch: Record<string, ValueRefV1 | null> = {};
  for (const [key, value] of Object.entries(edited)) {
    if (!sameStrictJsonValue(base[key], value)) patch[key] = value;
  }
  for (const key of Object.keys(base)) {
    if (!(key in edited)) patch[key] = null;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * The override that makes `base` read as `edited` on one machine ("Different on a machine…"): the
 * Configuration rows edit the machine's effective values, and only what differs from the server's own
 * configuration is stored. `applyMcpServerConfigOverrideV1(base, result)` restores `edited`. A machine
 * that matches the base has no override. The editor clears cwd for "Session folder"; a machine reset
 * from a fixed base path stores the explicit session choice so omission cannot inherit that path.
 */
export function diffMcpServerConfigOverride(
  base: McpServerCatalogEntryV1,
  edited: McpServerCatalogEntryV1,
): McpServerConfigOverrideFieldsV1 | undefined {
  const stdio: NonNullable<McpServerConfigOverrideFieldsV1['stdio']> = {};
  if (base.stdio && edited.stdio) {
    if (edited.stdio.command !== base.stdio.command)
      stdio.command = edited.stdio.command;
    if (!sameStrictJsonValue(edited.stdio.args, base.stdio.args))
      stdio.args = [...edited.stdio.args];
    const cwd = edited.stdio.cwd ?? { t: 'session' as const };
    if (!sameStrictJsonValue(cwd, base.stdio.cwd ?? { t: 'session' })) {
      stdio.cwd = cwd;
    }
  }
  const remote: NonNullable<McpServerConfigOverrideFieldsV1['remote']> = {};
  if (base.remote && edited.remote) {
    if (edited.remote.url !== base.remote.url) remote.url = edited.remote.url;
    const headersPatch = patchBetween(
      base.remote.headers,
      edited.remote.headers,
    );
    if (headersPatch) remote.headersPatch = headersPatch;
  }
  const envPatch = patchBetween(base.env, edited.env);
  const override: McpServerConfigOverrideFieldsV1 = {
    ...(Object.keys(stdio).length > 0 ? { stdio } : {}),
    ...(Object.keys(remote).length > 0 ? { remote } : {}),
    ...(envPatch ? { envPatch } : {}),
  };
  return Object.keys(override).length > 0 ? McpServerConfigOverrideFieldsV1Schema.parse(override) : undefined;
}
