import { join } from 'node:path';
import type { VoiceInferenceWorkerHandle } from '../voiceInferenceWorker';
import { assertVoiceInferencePackIdFilesystemSafe } from '../voiceInferenceWorker.shared';
import type { DaemonPublicVoiceModelPackRuntime } from './runtime';

export async function readResidentVoiceModelPackPaths(input: Readonly<{
    worker: Pick<VoiceInferenceWorkerHandle, 'getModelsStatus'> | null;
    modelPacks: Pick<DaemonPublicVoiceModelPackRuntime, 'list'> | null;
    packsRootDir: string;
}>): Promise<Readonly<{ reliable: boolean; paths: readonly string[] }>> {
    if (!input.worker) return { reliable: true, paths: [] };
    const [models, entries] = await Promise.all([input.worker.getModelsStatus(), input.modelPacks?.list() ?? []]);
    const byKey = new Map(entries.map(entry => [entry.key, entry]));
    const paths: string[] = [];
    let reliable = true;
    for (const model of models) {
        if (model.runtimeState !== 'warming' && model.runtimeState !== 'ready') continue;
        const entry = byKey.get(model.packId);
        if (entry) paths.push(join(input.packsRootDir, entry.directoryKey));
        else if (!model.pluginIdentity) {
            try {
                paths.push(join(input.packsRootDir, assertVoiceInferencePackIdFilesystemSafe(model.packId)));
            } catch {
                // A retired qualified contribution is not proof of a legacy directory.
                reliable = false;
            }
        } else reliable = false;
    }
    return { reliable, paths };
}
