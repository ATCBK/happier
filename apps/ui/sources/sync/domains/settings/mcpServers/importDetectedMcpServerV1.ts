import type { DetectedMcpServerV1, McpServerRuleV1, McpServerCatalogEntryV1, ValueRefV1, McpServersSettingsV1 } from '@happier-dev/protocol';
import { resolveCreateReachV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { resolveReachV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { applyMcpServerCatalogMutationV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';

import { addMcpServerCatalogEntryV1 } from './mcpServerCrud';
import {
    createUniqueMcpServerName,
    normalizeMcpServerNameCandidate,
    toEnvToken,
} from './mcpCatalogNaming';

function buildEnvFromDetectedEnvKeys(envKeys: readonly string[]): Record<string, ValueRefV1> {
    const out: Record<string, ValueRefV1> = {};
    for (const key of envKeys) {
        const k = String(key ?? '').trim();
        if (!k) continue;
        out[k] = { t: 'literal', v: `\${${k}}` };
    }
    return out;
}

function buildRemoteHeadersFromDetectedHeaders(params: Readonly<{ headerNames: readonly string[]; serverName: string }>): Record<string, ValueRefV1> {
    const out: Record<string, ValueRefV1> = {};
    const serverEnvToken = toEnvToken(params.serverName);
    for (const headerName of params.headerNames) {
        const k = String(headerName ?? '').trim();
        if (!k) continue;
        const headerEnvToken = toEnvToken(k);
        const envVarName = `MCP_${serverEnvToken}_${headerEnvToken}`;
        out[k] = { t: 'literal', v: `\${${envVarName}}` };
    }
    return out;
}

function normalizeRecordKeys(value: Record<string, unknown> | null | undefined): string[] {
    return Object.keys(value ?? {}).sort();
}

function normalizeDetectedName(raw: string): string {
    return normalizeMcpServerNameCandidate(raw);
}

function doesEntryNameMatchDetected(entry: McpServerCatalogEntryV1, detected: DetectedMcpServerV1): boolean {
    const normalizedDetected = normalizeDetectedName(detected.name);
    if (entry.name === normalizedDetected) return true;
    const title = typeof entry.title === 'string' ? normalizeDetectedName(entry.title) : '';
    return title === normalizedDetected;
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function doesExistingEntryMatchDetected(entry: McpServerCatalogEntryV1, detected: DetectedMcpServerV1): boolean {
    if (!doesEntryNameMatchDetected(entry, detected)) return false;
    if (entry.transport !== detected.transport) return false;

    const entryEnvKeys = normalizeRecordKeys(entry.env);
    const detectedEnvKeys = [...(detected.envKeys ?? [])].sort();
    if (!areStringArraysEqual(entryEnvKeys, detectedEnvKeys)) return false;

    if (detected.transport === 'stdio') {
        if (!entry.stdio || !detected.stdio) return false;
        return entry.stdio.command === detected.stdio.command && areStringArraysEqual(entry.stdio.args, detected.stdio.args);
    }

    if (!entry.remote || !detected.remote) return false;
    const entryHeaderKeys = normalizeRecordKeys(entry.remote.headers);
    const detectedHeaderKeys = [...(detected.remote.headers ?? [])].sort();
    return entry.remote.url === detected.remote.url && areStringArraysEqual(entryHeaderKeys, detectedHeaderKeys);
}

export type ResolveImportedMcpServerFromDetectedV1Result = Readonly<{
    entry: McpServerCatalogEntryV1;
    nextSettings: McpServersSettingsV1;
}> & Readonly<
    { action: 'created' | 'reused'; binding: McpServerRuleV1 }
    | { action: 'updated'; bindingAction: 'add' | 'edit'; binding: McpServerRuleV1 }
>;

export function buildImportedMcpServerFromDetectedV1(params: Readonly<{
    existingSettings: McpServersSettingsV1;
    detected: DetectedMcpServerV1;
    machineId: string;
    nowMs: number;
    generateId: () => string;
}>): Readonly<{ entry: McpServerCatalogEntryV1; binding: McpServerRuleV1 }> {
    const baseName = normalizeMcpServerNameCandidate(params.detected.name);
    const name = createUniqueMcpServerName({ base: baseName, settings: params.existingSettings });

    const nowMs = params.nowMs;
    const id = params.generateId();

    const entryBase = {
        id,
        name,
        title: params.detected.name.trim() ? params.detected.name.trim() : undefined,
        env: buildEnvFromDetectedEnvKeys(params.detected.envKeys ?? []),
        createdAt: nowMs,
        updatedAt: nowMs,
    } satisfies Omit<McpServerCatalogEntryV1, 'transport' | 'stdio' | 'remote'>;

    const entry: McpServerCatalogEntryV1 = params.detected.transport === 'stdio'
        ? {
            ...entryBase,
            transport: 'stdio',
            stdio: params.detected.stdio!,
            remote: undefined,
        }
        : {
            ...entryBase,
            transport: params.detected.transport,
            stdio: undefined,
            remote: {
                url: params.detected.remote!.url,
                headers: buildRemoteHeadersFromDetectedHeaders({
                    headerNames: params.detected.remote!.headers ?? [],
                    serverName: name,
                }),
            },
        };

    const reach = resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: 'ui' },
        ctx: { nowMs, newId: params.generateId } });
    if (!reach.ok) throw new Error(reach.code);
    const binding: McpServerRuleV1 = { ...reach.rules[0]!, serverId: id };

    return { entry, binding };
}

export function resolveImportedMcpServerFromDetectedV1(params: Readonly<{
    existingSettings: McpServersSettingsV1;
    detected: DetectedMcpServerV1;
    machineId: string;
    nowMs: number;
    generateId: () => string;
}>): ResolveImportedMcpServerFromDetectedV1Result {
    const existingEntry = params.existingSettings.servers.find((entry) => doesExistingEntryMatchDetected(entry, params.detected)) ?? null;
    if (!existingEntry) {
        const created = buildImportedMcpServerFromDetectedV1(params);
        return {
            action: 'created',
            entry: created.entry,
            binding: created.binding,
            nextSettings: addMcpServerCatalogEntryV1(params.existingSettings, created.entry, [created.binding]),
        };
    }

    const existingBindings = params.existingSettings.bindings.filter((binding) => binding.serverId === existingEntry.id);
    const desiredBinding = buildImportedMcpServerFromDetectedV1({
        ...params,
        existingSettings: { ...params.existingSettings, servers: [] },
    }).binding;
    const decision = resolveReachV1(existingBindings, { machineId: params.machineId, machinePlatform: null,
        directory: params.detected.source.kind === 'project' ? params.detected.source.path : null,
        projectKey: null, agentId: params.detected.provider });
    const coveredBinding = existingBindings.find(binding => binding.id === decision.decidedBy?.ruleId) ?? null;

    if (coveredBinding) {
        if (coveredBinding.enabled === desiredBinding.enabled) {
            return {
                action: 'reused',
                entry: existingEntry,
                binding: coveredBinding,
                nextSettings: params.existingSettings,
            };
        }

        const change = { kind: 'write' as const, write: { place: coveredBinding.target,
            ...(coveredBinding.agentId ? { agentId: coveredBinding.agentId } : {}), state: 'on' as const } };
        const next = applyMcpServerCatalogMutationV1({ v: 1, servers: params.existingSettings.servers, bindings: params.existingSettings.bindings },
            { kind: 'rules-change', serverIds: [existingEntry.id], change },
            { nowMs: params.nowMs, newId: params.generateId });
        return {
            action: 'updated',
            bindingAction: 'edit',
            entry: existingEntry,
            binding: { ...coveredBinding, enabled: desiredBinding.enabled, updatedAt: params.nowMs },
            nextSettings: { ...params.existingSettings, ...next },
        };
    }

    const appendedBinding: McpServerRuleV1 = { ...desiredBinding, serverId: existingEntry.id };
    const next = applyMcpServerCatalogMutationV1({ v: 1, servers: params.existingSettings.servers, bindings: params.existingSettings.bindings },
        { kind: 'rules-change', serverIds: [existingEntry.id], change: { kind: 'write', write: {
            place: appendedBinding.target, state: 'on' } } },
        { nowMs: params.nowMs, newId: () => appendedBinding.id });
    return {
        action: 'updated',
        bindingAction: 'add',
        entry: existingEntry,
        binding: appendedBinding,
        nextSettings: { ...params.existingSettings, ...next },
    };
}
