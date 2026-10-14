import { DetectedMcpServerV1Schema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { PluginMcpServerTransportV1Schema } from '@happier-dev/protocol/plugins/contributions/mcp';
import type {
    DaemonMcpServersDetectWarningV1,
    DetectedMcpServerV1,
} from '@happier-dev/protocol';
import type { PluginExecSpawnRequest } from './services/io.js';

export type McpServerTransportV1 =
    | Readonly<{
        kind: 'hosted';
        exposure?:
            | Readonly<{ kind: 'registryOnly' }>
            | Readonly<{ kind: 'loopbackHttp'; requested: true }>;
    }>
    | Readonly<{
        kind: 'stdio';
        launch: PluginExecSpawnRequest;
    }>
    | Readonly<{
        kind: 'http' | 'sse';
        url: string;
    }>;

export type McpDiscoveryWarningV1 = DaemonMcpServersDetectWarningV1;
export type {
    DaemonMcpServersDetectWarningV1,
    DetectedMcpServerV1,
};

export function normalizeDetectedMcpServerV1(value: unknown): DetectedMcpServerV1 | null {
    const parsed = DetectedMcpServerV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const server = parsed.data;
    if (server.remote && !PluginMcpServerTransportV1Schema.safeParse({ kind: 'http', url: server.remote.url }).success) return null;
    // Native files are opaque vendor documents; discovery discloses only the
    // public row and value names, never unknown fields or env/header values.
    return {
        provider: server.provider,
        name: server.name,
        transport: server.transport,
        ...(server.stdio ? { stdio: { command: server.stdio.command, args: [...server.stdio.args] } } : {}),
        ...(server.remote ? { remote: { url: server.remote.url, headers: [...server.remote.headers] } } : {}),
        envKeys: [...server.envKeys],
        enabled: server.enabled,
        ...(server.loadedInHappierSessions === undefined ? {} : { loadedInHappierSessions: server.loadedInHappierSessions }),
        source: { kind: server.source.kind, path: server.source.path },
    };
}
