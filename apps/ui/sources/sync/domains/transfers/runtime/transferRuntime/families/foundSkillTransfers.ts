import { FoundSkillBundleV1Schema, FoundSkillDownloadRequestV1Schema, type FoundSkillBundleV1 } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';
import { downloadJsonPayloadViaMachineCarrier } from '../carriers/downloadJsonPayloadViaMachineCarrier';

/** Found bytes are read on demand; the existing finite carrier owns transport and cleanup. */
export async function readFoundSkillBundle(machineId: string, path: string, opts?: Readonly<{
    serverId?: string | null;
    signal?: AbortSignal;
}>): Promise<FoundSkillBundleV1> {
    const request = FoundSkillDownloadRequestV1Schema.parse({ path });
    const result = await downloadJsonPayloadViaMachineCarrier({
        machineId,
        serverId: opts?.serverId,
        signal: opts?.signal,
        directExportRequest: { t: 'prompt_asset_download_v1', ...request },
        parsePayload: value => {
            const parsed = FoundSkillBundleV1Schema.safeParse(value);
            return parsed.success ? parsed.data : null;
        },
    });
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode ?? 'found_skill_unavailable' });
    return result.payload;
}
