import * as React from 'react';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';

import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

/**
 * The server's install link (`mcp.servers.read` → `installLink`: names, never values), or `undefined`
 * until the read answers or when the Home gives none. Read again when the catalog revision moves.
 */
export function useMcpServerInstallLink(
  execution: Pick<ReturnType<typeof useMountedActionExecution>, 'execute' | 'ready' | 'isCurrent'>,
  serverId: string,
  catalogRevision: number | 'absent' | null,
): string | undefined {
  const [link, setLink] = React.useState<Readonly<{ key: string; value: string | undefined }>>();
  const key = JSON.stringify([serverId, catalogRevision]);
  const latest = React.useRef(execution);
  latest.current = execution;
  const { ready } = execution;
  React.useEffect(() => {
    if (!ready || catalogRevision === null) return;
    let live = true;
    void latest.current.execute('mcp.servers.read', { serverId }).then((result) => {
      if (!live || !latest.current.isCurrent()) return;
      const parsed = result.ok ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].safeParse(result.result) : null;
      const value = parsed?.success && parsed.data.status === 'present' ? parsed.data.installLink : undefined;
      setLink((previous) => previous?.key === key && previous.value === value ? previous : { key, value });
    });
    return () => { live = false; };
  }, [catalogRevision, key, ready, serverId]);
  return link?.key === key ? link.value : undefined;
}
