import { RegistryDownloadRequestV1Schema, RegistrySkillFilesPayloadV1Schema,
    type RegistryDownloadRequestV1 } from '@happier-dev/protocol/registries';
import { downloadJsonPayloadViaMachineCarrier } from '../carriers/downloadJsonPayloadViaMachineCarrier';

type RegistryTransferOptions = Readonly<{ serverId?: string | null; timeoutMs?: number | null; signal?: AbortSignal }>;
export async function downloadDaemonPromptRegistryItem(machineId: string, input: RegistryDownloadRequestV1,
    opts?: RegistryTransferOptions) {
    const payload = RegistryDownloadRequestV1Schema.parse(input);
    return downloadJsonPayloadViaMachineCarrier({
        machineId, serverId: opts?.serverId, timeoutMs: opts?.timeoutMs ?? undefined, signal: opts?.signal,
        parsePayload: value => {
            const parsed = RegistrySkillFilesPayloadV1Schema.safeParse(value);
            return parsed.success ? parsed.data : null;
        },
        directExportRequest: { t: 'prompt_registry_download_v1', ...payload },
    });
}
