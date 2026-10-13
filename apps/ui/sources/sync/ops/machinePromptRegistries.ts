import type { RegistryDownloadRequestV1 } from '@happier-dev/protocol/registries';
import { downloadDaemonPromptRegistryItem } from '@/sync/domains/transfers/runtime/transferRuntime/families/promptRegistryTransfers';

/** Finite bytes only; discovery and source mutations use registries.* Actions. */
export async function machinePromptRegistriesDownloadItem(machineId: string, input: RegistryDownloadRequestV1,
    opts?: Readonly<{ serverId?: string | null; timeoutMs?: number | null; signal?: AbortSignal }>) {
    return downloadDaemonPromptRegistryItem(machineId, input, opts);
}
