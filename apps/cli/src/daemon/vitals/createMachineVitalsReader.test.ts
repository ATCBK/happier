import { describe, expect, it } from 'vitest';
import { createMachineVitalsReader } from './createMachineVitalsReader';
import { createLinuxVitalsFixture } from './readers/linux.testkit';
import type { ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';

describe('createMachineVitalsReader', () => {
    it('forwards the daemon lifetime to native launches on both platforms', async () => {
        const controller = new AbortController();
        controller.abort();
        const execFile: ProcessCustodyExecFile = async (_command, _args, options) => {
            if (options.signal?.aborted) throw new Error('OS launch cancelled');
            return { stdout: JSON.stringify({ v: 1, t: 'vitals-sample', sample: {
                cpu: [{ user: 1, system: 1, idle: 1 }],
                memory: { totalBytes: 100, availableBytes: 50, pressureLevel: 'not_reported', pressureSource: 'none' },
                volumes: [], interfaces: [],
            } }), stderr: '' };
        };
        for (const platform of ['darwin', 'win32'] as const) {
            const reader = createMachineVitalsReader({ platform, signal: controller.signal, native: { executablePath: '/helper', execFile } });
            expect(await reader.read({ sampledAt: 0, monotonicMs: 0, intervalMs: 2000, overviewExtras: false })).toEqual({ state: 'unavailable', reason: 'helper_failing' });
        }
    });
    it('uses procfs on Linux and the typed helper availability contract on macOS and Windows', async () => {
        const fixture = await createLinuxVitalsFixture();
        try {
            const input = { sampledAt: 1_000_000, monotonicMs: 0, intervalMs: 60_000, overviewExtras: false };
            const linux = createMachineVitalsReader({ platform: 'linux', linux: { root: fixture.root } });
            expect(await linux.read(input)).toMatchObject({ state: 'reporting', sample: { memory: { usedBytes: 61_440_000 } } });
            for (const platform of ['darwin', 'win32'] as const) {
                // Missing executable is a genuine OS/process boundary, not mocked reader logic.
                const native = createMachineVitalsReader({ platform, linux: { root: fixture.root }, native: { executablePath: null } });
                expect(await native.read(input)).toEqual({ state: 'unavailable', reason: 'helper_missing' });
            }
        } finally {
            await fixture.cleanup();
        }
    });
});
