import { execFileWithDeadline, resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { NVIDIA_VITALS_ARGS, parseNvidiaVitalsGpu } from './extras/gpu';
import { createNativeMachineVitalsReader, type NativeMachineVitalsReaderOptions } from './native';

export function createWindowsMachineVitalsReader(options: NativeMachineVitalsReaderOptions = {}) {
    const core = createNativeMachineVitalsReader('win32', options);
    const run = options.execFile ?? execFileWithDeadline;
    let lastGpuAt = -Infinity;
    let gpu: MachineVitalsSampleV1['gpu'];
    return { read: async (input: Parameters<typeof core.read>[0]) => {
        const result = await core.read(input);
        if (result.state !== 'reporting' || !input.overviewExtras) return result;
        if (input.monotonicMs < lastGpuAt || input.monotonicMs - lastGpuAt >= 15_000) {
            lastGpuAt = input.monotonicMs;
            gpu = undefined;
            const executable = resolveWindowsCommandOnPath('nvidia-smi.exe');
            if (executable) {
                try {
                    const parsed = parseNvidiaVitalsGpu(String((await run(executable, NVIDIA_VITALS_ARGS, { encoding: 'utf8', signal: options.signal })).stdout));
                    if (parsed.length) gpu = parsed;
                } catch { /* No optional GPU signal is preferable to a guessed zero. */ }
            }
        }
        if (gpu) result.sample.gpu = gpu;
        return result;
    } };
}
