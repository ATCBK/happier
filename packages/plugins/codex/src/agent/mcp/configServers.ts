import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import type { DetectedMcpServerV1, DiscoveryWarning as McpDiscoveryWarningV1 } from '@happier-dev/plugin-sdk/mcp';

export type ReadCodexMcpConfigServersResult = Readonly<{
    servers: ReadonlyArray<DetectedMcpServerV1>;
    warnings: ReadonlyArray<McpDiscoveryWarningV1>;
}>;

export function resolveCodexHome(env: NodeJS.ProcessEnv): string {
    const codexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
    const home = resolveHomeDirFromEnvironment(env);
    return codexHome ? expandHomePath(codexHome, home) : join(home, '.codex');
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function readCodexMcpConfig(env: NodeJS.ProcessEnv): Readonly<{
    path: string;
    entries: Readonly<Record<string, unknown>>;
    warnings: ReadonlyArray<McpDiscoveryWarningV1>;
}> {
    const path = join(resolveCodexHome(env), 'config.toml');
    if (!existsSync(path)) return { path, entries: {}, warnings: [] };
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return { path, entries: {}, warnings: [{ provider: 'codex', code: 'read_failed', path }] };
    }
    try {
        return { path, entries: readRecord(parseToml(text).mcp_servers) ?? {}, warnings: [] };
    } catch {
        return { path, entries: {}, warnings: [{ provider: 'codex', code: 'parse_failed', path }] };
    }
}

export function readCodexMcpServerKeysFromConfigToml(env: NodeJS.ProcessEnv): string[] {
    return Object.keys(readCodexMcpConfig(env).entries).sort().map((name) => (
        /^[A-Za-z0-9_-]+$/u.test(name) ? name : JSON.stringify(name)
    ));
}

export async function readCodexMcpConfigServers(
    params: Readonly<{ env?: NodeJS.ProcessEnv }>,
): Promise<ReadCodexMcpConfigServersResult> {
    const parsed = readCodexMcpConfig(params.env ?? process.env);
    const servers: DetectedMcpServerV1[] = [];
    for (const [name, value] of Object.entries(parsed.entries)) {
        const entry = readRecord(value);
        if (typeof entry?.command !== 'string' || !entry.command.trim()) continue;
        const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];

        servers.push({
            provider: 'codex',
            name,
            transport: 'stdio',
            stdio: { command: entry.command, args },
            envKeys: [],
            enabled: typeof entry.enabled === 'boolean' ? entry.enabled : null,
            source: { kind: 'user', path: parsed.path },
        });
    }

    return { servers, warnings: parsed.warnings };
}
