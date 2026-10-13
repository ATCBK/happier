import type { McpImportValuesV1 } from '@happier-dev/protocol/mcp/servers/import/mcpServerImportV1';
import type { ImportedMcpDraftValueV1, ImportedMcpServerDraftV1 } from '@happier-dev/protocol/mcp/servers/import/parseMcpServerImportV1';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';

/** Interim editor fields; the protocol Action owns validation and all authoring. */
export type ImportedMcpInputResolutionV1 =
    | { mode: 'machineEnv'; envVarName: string }
    | { mode: 'savedSecret'; secretName: string; secretValue: string; secretKind?: SavedSecret['kind'] };

export function importedMcpMappingsToActionValuesV1(mappings: Readonly<Record<string, ImportedMcpInputResolutionV1>>): McpImportValuesV1 {
    return Object.fromEntries(Object.entries(mappings).map(([id, mapping]) => [id, mapping.mode === 'machineEnv'
        ? { t: 'literal' as const, v: `\${${mapping.envVarName.trim()}}` }
        : { t: 'createSecret' as const, name: mapping.secretName, value: mapping.secretValue,
            ...(mapping.secretKind ? { kind: mapping.secretKind } : {}) }]));
}

/** Serialize the remaining preset UI into the public paste Action; no catalog decisions live here. */
export function serializeMcpImportDraftsV1(drafts: readonly ImportedMcpServerDraftV1[]): string {
    const value = (ref: ImportedMcpDraftValueV1): string => ref.t === 'literal' ? ref.v : ref.t === 'input' ? `\${input:${ref.inputId}}`
        : ref.template.replace(/\{([^{}]+)\}/gu, (_match, name: string) => `\${input:${ref.vars[name]!.inputId}}`);
    return JSON.stringify({ servers: Object.fromEntries(drafts.map(draft => [draft.name, { title: draft.title, transport: draft.transport,
        ...(draft.stdio ? { command: draft.stdio.command, args: draft.stdio.args } : {}),
        ...(draft.remote ? { url: draft.remote.url, headers: Object.fromEntries(Object.entries(draft.remote.headers).map(([key, ref]) => [key, value(ref)])) } : {}),
        env: Object.fromEntries(Object.entries(draft.env).map(([key, ref]) => [key, value(ref)])),
    }])) });
}
