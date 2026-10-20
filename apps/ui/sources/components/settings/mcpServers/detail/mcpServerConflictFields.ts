import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { describeValueRef } from '@/components/ui/forms/valueRefs/ValueRefRowsEditor';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { t } from '@/text';

export type McpConflictField = Readonly<{ id: string; label: string; current: string; mine: string; mono: boolean }>;

type Resolve = (secretId: string) => string | null;

function folder(server: McpServerCatalogEntryV1): string {
  const cwd = server.stdio?.cwd;
  return cwd?.t === 'path' ? cwd.path : t('capabilities.mcp.config.sessionFolder');
}

/**
 * What differs between the saved server now and the person's open version, one row per Configuration
 * value, in the order the Configuration section shows them. Values are the ones that section shows
 * (a saved secret by name, never its value).
 */
export function mcpServerConflictFields(
  current: McpServerCatalogEntryV1,
  mine: McpServerCatalogEntryV1,
  secretName: Resolve,
): readonly McpConflictField[] {
  const notSet = t('capabilities.mcp.detail.conflict.notSet');
  const rows: McpConflictField[] = [];
  const add = (id: string, label: string, left: unknown, right: unknown, show: (value: unknown) => string, mono = true) => {
    if (sameStrictJsonValue(left, right)) return;
    rows.push({ id, label, current: show(left), mine: show(right), mono });
  };
  const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : notSet);
  const ref = (value: unknown) => (value ? describeValueRef(value as ValueRefV1, (id) => secretName(id)) : notSet);

  add('transport', t('capabilities.mcp.config.transport'), current.transport, mine.transport, text, false);
  add('command', t('capabilities.mcp.config.command'), current.stdio?.command, mine.stdio?.command, text);
  add('args', t('capabilities.mcp.config.arguments'), current.stdio?.args, mine.stdio?.args,
    (value) => (Array.isArray(value) && value.length > 0 ? value.join(' ') : notSet));
  if (current.stdio || mine.stdio) {
    add('cwd', t('capabilities.mcp.config.workingFolder'), current.stdio ? folder(current) : undefined, mine.stdio ? folder(mine) : undefined, text);
  }
  add('url', t('capabilities.mcp.config.address'), current.remote?.url, mine.remote?.url, text);
  const maps = [
    { id: 'header', label: t('capabilities.mcp.config.headers'), left: current.remote?.headers, right: mine.remote?.headers },
    { id: 'env', label: t('capabilities.mcp.config.environment'), left: current.env, right: mine.env },
  ];
  for (const map of maps) {
    const keys = [...new Set([...Object.keys(map.left ?? {}), ...Object.keys(map.right ?? {})])];
    for (const key of keys) {
      add(`${map.id}:${key}`, `${map.label} · ${key}`, map.left?.[key], map.right?.[key], ref);
    }
  }
  const count = (value: unknown) => (Array.isArray(value) && value.length > 0
    ? t('capabilities.mcp.config.differentCount', { count: value.length })
    : t('capabilities.mcp.config.differentNone'));
  add('overrides', t('capabilities.mcp.detail.conflict.machines'), current.configOverrides, mine.configOverrides, count, false);
  return rows;
}
