import * as React from 'react';
import type { z } from 'zod/mini';
import type { Metadata } from '@happier-dev/session-core/state';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { buildPermissionPromptModel } from './buildPermissionPromptModel';

type ToolsList = z.infer<(typeof MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1)['mcp.servers.tools.list']>;

/** MCP default facts come from the existing tools Action, on the approval's captured Home. */
export function usePermissionPromptModel(input: Readonly<{
    request: PendingPermissionRequest; metadata: Metadata | null; nowMs: number; scope: ServerAccountScope | null;
}>) {
    const execution = useMountedActionExecution(input.scope);
    const identity = ResolvedMcpToolIdentityV1Schema.safeParse(input.request.mcpTool);
    const serverId = identity.success && identity.data.server !== 'happier' ? identity.data.item.serverId : null;
    const key = JSON.stringify([input.scope?.serverId, input.scope?.accountId, serverId]);
    const [snapshot, setSnapshot] = React.useState<Readonly<{ key: string; value: ToolsList }> | null>(null);
    const [status, setStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const request = React.useRef(0);
    const refresh = React.useCallback(async () => {
        if (!serverId || !execution.ready) return;
        const turn = ++request.current;
        setStatus('loading'); setError(null);
        try {
            const receipt = await execution.execute('mcp.servers.tools.list', { serverId });
            if (turn !== request.current) return;
            const parsed = receipt.ok ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].safeParse(receipt.result) : null;
            if (parsed?.success) { setSnapshot({ key, value: parsed.data }); setStatus('ready'); }
            else { setStatus('error'); setError(!receipt.ok ? receipt.errorCode ?? 'mcp_catalog_operation_failed' : 'invalid_action_output'); }
        } catch { if (turn === request.current) { setStatus('error'); setError('mcp_catalog_operation_failed'); } }
    }, [key, serverId, execution.execute, execution.ready]);
    React.useEffect(() => {
        if (serverId && execution.ready) void refresh();
        else { setStatus('idle'); setError(null); }
        return () => { request.current++; };
    }, [serverId, execution.ready, refresh]);
    const tools = snapshot?.key === key ? snapshot.value : null;
    const serverDefault = tools?.settings.default ?? null;
    const model = React.useMemo(() => buildPermissionPromptModel({ request: input.request, metadata: input.metadata,
        nowMs: input.nowMs, serverDefault }), [input.request, input.metadata, input.nowMs, serverDefault]);
    return { model, tools, status, error, refresh };
}
