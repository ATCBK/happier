import * as React from 'react';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import type { McpServerTestFact } from './mcpServerStatus';

export type McpServerMachineTest = McpServerTestFact & Readonly<{ stderrTail?: string; durationMs?: number; message?: string }>;
type Results = Readonly<Record<string, McpServerMachineTest | undefined>>;
type Snapshot = Readonly<{ results: Results; running: ReadonlySet<string> }>;
type Entry = { configuration: string; pluginDefinition?: McpServerCatalogEntryV1; snapshot: Snapshot };
type Partition = { entries: Map<string, Entry>; listeners: Set<() => void> };
const EMPTY: Snapshot = Object.freeze({ results: {}, running: new Set<string>() });

// On-demand facts survive reopening only within the incumbent Account lifetime and tested configuration.
const sessionResults = new WeakMap<ActiveServerAccountScopeLifetime, Partition>();

function configuration(lifetime: ActiveServerAccountScopeLifetime, serverId: string, pluginDefinition?: McpServerCatalogEntryV1): string | null {
    const catalog = getMcpServerCatalogSnapshot(lifetime.scope).value;
    const server = catalog?.servers.find(server => server.id === serverId)
        ?? (serverId.startsWith('plugin:') ? pluginDefinition : undefined);
    return server ? stableJsonStringify([server.name, server.transport, server.stdio, server.remote, server.env,
        server.configOverrides]) : null;
}

function partitionFor(lifetime: ActiveServerAccountScopeLifetime): Partition {
    const existing = sessionResults.get(lifetime);
    if (existing) return existing;
    const partition: Partition = { entries: new Map(), listeners: new Set() };
    sessionResults.set(lifetime, partition);
    const unsubscribe = subscribeMcpServerCatalogSnapshots(() => {
        // A refresh retains facts; a proven configuration change or deletion retires them, even with no page open.
        const catalog = getMcpServerCatalogSnapshot(lifetime.scope);
        if (catalog.status !== 'ready' && catalog.status !== 'partial') return;
        let changed = false;
        for (const [id, entry] of partition.entries) {
            if (configuration(lifetime, id, entry.pluginDefinition) === entry.configuration) continue;
            partition.entries.delete(id);
            changed = true;
        }
        if (changed) for (const listener of partition.listeners) listener();
    });
    lifetime.onRetire(() => {
        unsubscribe();
        partition.entries.clear();
        sessionResults.delete(lifetime);
        for (const listener of partition.listeners) listener();
    });
    return partition;
}

/** The canonical Test Action, with late answers fenced by the Account and configuration that requested them. */
export function useMcpServerMachineTests(serverId: string, pluginDefinition?: McpServerCatalogEntryV1) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const execution = useMountedActionExecution(lifetime?.scope ?? null);
    const partition = React.useMemo(() => lifetime ? partitionFor(lifetime) : null, [lifetime]);
    const read = React.useCallback(() => {
        if (!lifetime?.isCurrent() || !partition) return EMPTY;
        const signature = configuration(lifetime, serverId, pluginDefinition);
        if (!signature) return EMPTY;
        let entry = partition.entries.get(serverId);
        if (!entry || entry.configuration !== signature) {
            entry = { configuration: signature, ...(serverId.startsWith('plugin:') ? { pluginDefinition } : {}), snapshot: EMPTY };
            partition.entries.set(serverId, entry);
        }
        return entry.snapshot;
    }, [lifetime, partition, serverId, pluginDefinition]);
    const subscribe = React.useCallback((listener: () => void) => {
        if (!partition) return () => {};
        partition.listeners.add(listener);
        const unsubscribe = subscribeMcpServerCatalogSnapshots(listener);
        return () => { partition.listeners.delete(listener); unsubscribe(); };
    }, [partition]);
    const snapshot = React.useSyncExternalStore(subscribe, read, read);
    const run = React.useCallback((machineIds: readonly string[]) => {
        if (!lifetime?.isCurrent() || !partition || !execution.ready) return;
        read();
        const entry = partition.entries.get(serverId);
        if (!entry) return;
        const current = () => lifetime.isCurrent() && partition.entries.get(serverId) === entry
            && configuration(lifetime, serverId, pluginDefinition) === entry.configuration;
        const emit = () => { for (const listener of partition.listeners) listener(); };
        const targets = [...new Set(machineIds)].filter(id => !entry.snapshot.running.has(id));
        entry.snapshot = { ...entry.snapshot, running: new Set([...entry.snapshot.running, ...targets]) };
        emit();
        for (const machineId of targets) void (async () => {
            const receipt = await execution.execute('mcp.servers.test', { t: 'byId', machineId, directory: '/', serverId }).catch(() => null);
            if (!current()) return;
            const parsed = receipt?.ok ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.test'].safeParse(receipt.result) : null;
            const checkedAt = Date.now();
            const response = parsed?.success ? parsed.data : null;
            const result: McpServerMachineTest = response ? response.ok
                ? { ok: true, toolCount: response.toolCount, checkedAt, durationMs: response.durationMs, ...(response.stderrTail ? { stderrTail: response.stderrTail } : {}) }
                : { ok: false, errorCode: response.errorCode, message: response.error, checkedAt, durationMs: response.durationMs,
                    ...(response.runtimeMissing ? { runtimeMissing: response.runtimeMissing } : {}), ...(response.stderrTail ? { stderrTail: response.stderrTail } : {}) }
                : { ok: false, errorCode: receipt && !receipt.ok ? receipt.errorCode ?? 'test_failed' : 'test_failed',
                    ...(receipt && !receipt.ok && receipt.error ? { message: receipt.error } : {}), checkedAt };
            const running = new Set(entry.snapshot.running);
            running.delete(machineId);
            entry.snapshot = { results: { ...entry.snapshot.results, [machineId]: result }, running };
            emit();
        })();
    }, [execution.execute, execution.ready, lifetime, partition, read, serverId, pluginDefinition]);
    return React.useMemo(() => ({ ...snapshot, run }), [snapshot, run]);
}
