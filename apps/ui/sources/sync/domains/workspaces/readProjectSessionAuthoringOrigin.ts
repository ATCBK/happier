import { StoredPluginUiNewSessionSeedOriginV1Schema, type PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';

/** Read only the registered private work field, never infer origin from machine/path. */
export function readProjectSessionAuthoringOrigin(metadata: unknown): PluginUiNewSessionSeedOriginV1 | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('work' in metadata)) return null;
    const work = metadata.work;
    if (!work || typeof work !== 'object' || Array.isArray(work) || !('authoringOriginV1' in work)) return null;
    const parsed = StoredPluginUiNewSessionSeedOriginV1Schema.safeParse(work.authoringOriginV1);
    return parsed.success ? parsed.data : null;
}
