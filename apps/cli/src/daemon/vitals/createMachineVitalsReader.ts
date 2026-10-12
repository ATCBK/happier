import { createLinuxMachineVitalsReader, type LinuxMachineVitalsReaderOptions } from './readers/linux';
import { createDarwinMachineVitalsReader } from './readers/darwin';
import { createWindowsMachineVitalsReader } from './readers/windows';
import type { NativeMachineVitalsReaderOptions } from './readers/native';
import type { MachineVitalsReader } from './readers/types';

export interface MachineVitalsReaderOptions {
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
    linux?: LinuxMachineVitalsReaderOptions;
    native?: NativeMachineVitalsReaderOptions;
}

/** Selects the platform OS boundary without changing the sampler's contract. */
export function createMachineVitalsReader(options: MachineVitalsReaderOptions = {}): MachineVitalsReader {
    switch (options.platform ?? process.platform) {
        case 'linux': return createLinuxMachineVitalsReader({ ...options.linux, signal: options.signal });
        case 'darwin': return createDarwinMachineVitalsReader({ ...options.native, signal: options.signal });
        case 'win32': return createWindowsMachineVitalsReader({ ...options.native, signal: options.signal });
        default: throw new Error(`Unsupported machine vitals platform: ${options.platform ?? process.platform}`);
    }
}
