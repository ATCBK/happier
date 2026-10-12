import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { MachineVitalsSampleV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { createDarwinMachineVitalsReader } from './darwin';
import { createLinuxMachineVitalsReader } from './linux';
import { createWindowsMachineVitalsReader } from './windows';
import type { ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';

async function main() {
    const spawns: { command: string; args: readonly string[] }[] = [];
    const execFile: ProcessCustodyExecFile = async (command, args, options) => {
        spawns.push({ command, args });
        return await execFileWithDeadline(command, args, options);
    };
    const options = { executablePath: process.argv[2], execFile };
    const reader = process.platform === 'darwin' ? createDarwinMachineVitalsReader(options)
        : process.platform === 'win32' ? createWindowsMachineVitalsReader(options) : createLinuxMachineVitalsReader({ execFile });
    const observations = [];
    for (const overviewExtras of [false, true, true, false]) {
        const before = spawns.length;
        const result = await reader.read({ sampledAt: Date.now(), monotonicMs: performance.now(), intervalMs: 2000, overviewExtras });
        assert.equal(result.state, 'reporting');
        if (result.state !== 'reporting') throw Error(JSON.stringify(result));
        MachineVitalsSampleV1Schema.parse(result.sample);
        if (!overviewExtras) assert(!result.sample.gpu && !result.sample.battery);
        for (const gpu of result.sample.gpu ?? []) if (gpu.powerState === 'off') assert(gpu.busyPct === undefined && gpu.memUsedBytes === undefined);
        observations.push({ overviewExtras, power: result.sample.power, battery: result.sample.battery, gpu: result.sample.gpu,
            spawns: spawns.slice(before) });
    }
    console.log(JSON.stringify({ platform: process.platform, runtime: process.version, observations }));
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
