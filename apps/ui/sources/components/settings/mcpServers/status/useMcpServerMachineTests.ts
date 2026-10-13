import * as React from 'react';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import type { McpServerTestFact } from './mcpServerStatus';

export type McpServerMachineTest = McpServerTestFact & Readonly<{ stderrTail?: string; durationMs?: number; /** The failure as the machine said it. */ message?: string }>;
type Results = Readonly<Record<string, McpServerMachineTest | undefined>>;

/**
 * Test answers live for the app session only (T7): computed on demand, never stored per machine. Keyed by
 * server, so returning to a server shows what this client last saw.
 */
const sessionResults = new Map<string, Results>();

/** `mcp.servers.test` on chosen machines, each row resolving as its answer arrives. */
export function useMcpServerMachineTests(serverId: string): Readonly<{
    results: Results;
    running: ReadonlySet<string>;
    run: (machineIds: readonly string[]) => void;
}> {
    const activeScope = useAccountSettingsScope();
    const homeId = activeScope?.serverId;
    const accountId = activeScope?.accountId;
    const scope = React.useMemo(() => (homeId && accountId ? { serverId: homeId, accountId } : null), [homeId, accountId]);
    const execution = useMountedActionExecution(scope);
    const execute = execution.execute;
    const [results, setResults] = React.useState<Results>(() => sessionResults.get(serverId) ?? {});
    const [running, setRunning] = React.useState<ReadonlySet<string>>(() => new Set());

    const record = React.useCallback((machineId: string, result: McpServerMachineTest) => {
        setResults((current) => {
            const next = { ...current, [machineId]: result };
            sessionResults.set(serverId, next);
            return next;
        });
    }, [serverId]);

    const run = React.useCallback((machineIds: readonly string[]) => {
        setRunning((current) => new Set([...current, ...machineIds]));
        for (const machineId of machineIds) {
            void (async () => {
                const receipt = await execute('mcp.servers.test', { t: 'byId', machineId, directory: '/', serverId }).catch(() => null);
                const parsed = receipt?.ok ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.test'].safeParse(receipt.result) : null;
                const checkedAt = Date.now();
                if (parsed?.success) {
                    const response = parsed.data;
                    record(machineId, response.ok
                        ? { ok: true, toolCount: response.toolCount, checkedAt, durationMs: response.durationMs, ...(response.stderrTail ? { stderrTail: response.stderrTail } : {}) }
                        : { ok: false, errorCode: response.errorCode, message: response.error, checkedAt, durationMs: response.durationMs,
                            ...(response.runtimeMissing ? { runtimeMissing: response.runtimeMissing } : {}),
                            ...(response.stderrTail ? { stderrTail: response.stderrTail } : {}) });
                } else {
                    record(machineId, { ok: false, errorCode: receipt && !receipt.ok ? receipt.errorCode ?? 'test_failed' : 'test_failed',
                        ...(receipt && !receipt.ok && receipt.error ? { message: receipt.error } : {}), checkedAt });
                }
                setRunning((current) => {
                    const next = new Set(current);
                    next.delete(machineId);
                    return next;
                });
            })();
        }
    }, [execute, record, serverId]);

    return React.useMemo(() => ({ results, running, run }), [results, run, running]);
}
