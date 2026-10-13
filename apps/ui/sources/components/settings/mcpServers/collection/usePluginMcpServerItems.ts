import * as React from 'react';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import {
  McpPluginItemMetadataV1Schema,
  type McpPluginItemMetadataV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

const NONE: readonly McpPluginItemMetadataV1[] = [];

/**
 * The MCP servers active plugins declare (T8), from the same `mcp.servers.list` Action every caller uses:
 * read once per open of the page. Plugin rows are read-only here; they leave with their plugin.
 */
export function usePluginMcpServerItems(): readonly McpPluginItemMetadataV1[] {
  const activeScope = useAccountSettingsScope();
  const homeId = activeScope?.serverId;
  const accountId = activeScope?.accountId;
  const scope = React.useMemo(
    () => (homeId && accountId ? { serverId: homeId, accountId } : null),
    [homeId, accountId],
  );
  const { execute, ready } = useMountedActionExecution(scope);
  const [items, setItems] =
    React.useState<readonly McpPluginItemMetadataV1[]>(NONE);

  React.useEffect(() => {
    if (!scope || !ready) return;
    let cancelled = false;
    void (async () => {
      const receipt = await execute('mcp.servers.list', {}).catch(() => null);
      if (cancelled || !receipt?.ok) return;
      const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[
        'mcp.servers.list'
      ].safeParse(receipt.result);
      if (
        !parsed.success ||
        (parsed.data.status !== 'ready' && parsed.data.status !== 'partial')
      )
        return;
      const next = parsed.data.catalog.servers.flatMap((server) => {
        const plugin = McpPluginItemMetadataV1Schema.safeParse(server);
        return plugin.success ? [plugin.data] : [];
      });
      setItems((current) =>
        next.length === 0 && current.length === 0 ? current : next,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [execute, ready, scope]);

  return items;
}
