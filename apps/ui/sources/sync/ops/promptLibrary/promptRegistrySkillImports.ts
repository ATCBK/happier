import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1, SkillInstallAcknowledgedEffectsV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';

export type PromptRegistrySkillImportResult = Readonly<{ ok: true; artifactId: string; incomplete?: 'rules' | 'session_include'; acknowledgedError?: string }>
    | Readonly<{ ok: false; error: string }>;

export async function importPromptRegistrySkillItem(args: Readonly<{ sourceId: string; itemId: string; version?: string;
    serverId?: string | null; expectedAccountId?: string; signal?: AbortSignal }>,
    mounted?: MountedAuthoringActionExecute): Promise<PromptRegistrySkillImportResult> {
    const execute: MountedAuthoringActionExecute = mounted ?? (async (actionId, input, options) => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        return createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', authority: 'present_user',
            serverId: args.serverId ?? undefined, expectedAccountId: args.expectedAccountId, signal: options?.signal });
    });
    const read = await execute('registries.items.read', { kind: 'skill', sourceId: args.sourceId, itemId: args.itemId,
        ...(args.version ? { version: args.version } : {}) }, { signal: args.signal });
    if (!read.ok) return { ok: false, error: read.error };
    const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(read.result).item;
    if (!item.summary.version) return { ok: false, error: 'registry_version_unavailable' };
    const install = await execute('skills.install', { source: { kind: 'registry', sourceId: item.summary.sourceId,
        itemId: item.summary.itemId, version: item.summary.version } }, { signal: args.signal });
    if (!install.ok) {
        const effects = SkillInstallAcknowledgedEffectsV1Schema.safeParse(install.details);
        if (effects.success && effects.data.skillIds[0]) return { ok: true, artifactId: effects.data.skillIds[0],
            acknowledgedError: install.errorCode ?? 'skill_content_acknowledged',
            ...(effects.data.incomplete[0] ? { incomplete: effects.data.incomplete[0].step } : {}) };
        return { ok: false, error: install.error };
    }
    if (install.result && typeof install.result === 'object' && 'ok' in install.result && install.result.ok === false) {
        return { ok: false, error: 'code' in install.result && typeof install.result.code === 'string' ? install.result.code : 'skill_install_failed' };
    }
    const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(install.result);
    if (!('skillIds' in result) || !result.skillIds[0]) return { ok: false, error: 'skill_install_failed' };
    return { ok: true, artifactId: result.skillIds[0], ...(result.incomplete?.[0] ? { incomplete: result.incomplete[0].step } : {}) };
}
