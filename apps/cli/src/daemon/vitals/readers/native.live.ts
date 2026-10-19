/** Source-driven native reader probe. Bundle with esbuild and run on the target OS. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { MachineVitalsSampleV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { createDarwinMachineVitalsReader } from './darwin';
import { createWindowsMachineVitalsReader } from './windows';
import type { ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';

async function main() {
    assert(process.platform === 'darwin' || process.platform === 'win32', 'Probe requires a native macOS or Windows process');
    const executablePath = process.argv[2];
    assert(executablePath, 'Native helper path is required');
    const spawns: { command: string; args: readonly string[] }[] = [];
    const execFile: ProcessCustodyExecFile = async (command, args, options) => {
        spawns.push({ command, args });
        return await execFileWithDeadline(command, args, options);
    };
    const reader = process.platform === 'darwin' ? createDarwinMachineVitalsReader({ executablePath, execFile }) : createWindowsMachineVitalsReader({ executablePath, execFile });
    const timings: number[] = [];
    const cpuMicros: number[] = [];
    let last;
    for (const overviewExtras of [false, false, true, true, false]) {
        const start = performance.now();
        const cpuBefore = process.cpuUsage();
        const before = spawns.length;
        const sampledAt = Date.now();
        const result = await reader.read({ sampledAt, monotonicMs: start, intervalMs: 2000, overview: overviewExtras, overviewExtras });
        timings.push(performance.now() - start);
        const cpu = process.cpuUsage(cpuBefore);
        cpuMicros.push(cpu.user + cpu.system);
        assert.equal(result.state, 'reporting', JSON.stringify(result));
        if (result.state !== 'reporting') throw Error('Reader unavailable');
        MachineVitalsSampleV1Schema.parse(result.sample);
        assert(result.sample.cpu.reported && result.sample.cpu.perCore?.length === result.host.logicalCores);
        assert(result.sample.memory.reported && result.sample.memory.availableBytes + result.sample.memory.usedBytes === result.sample.memory.totalBytes);
        if (process.platform === 'win32') assert.deepEqual(result.sample.memory.pressure, { level: 'not_reported', source: 'none' });
        assert(result.sample.network.reported);
        if (!last || start - last.minuteCounters.monotonicMs > 4000) assert.equal(result.sample.cpu.busyPct, null);
        else assert.notEqual(result.sample.cpu.busyPct, null);
        assert(result.sample.disk.reported && result.sample.disk.volumes.length > 0);
        if (!overviewExtras) {
            assert(!result.sample.battery && !result.sample.gpu && !result.sample.thermal);
            // Static labels once; no power-dependent policy means no battery tool.
            assert.equal(spawns.length - before, process.platform === 'darwin'
                ? 1 + (last ? 0 : 1) : 1);
        }
        if (result.sample.memory.composition) {
            assert.equal(result.sample.memory.composition.reduce((sum, segment) => sum + segment.bytes, 0), result.sample.memory.usedBytes);
        }
        if (process.platform === 'darwin') {
            assert.equal(spawns.slice(before).filter(({ command }) => command === '/usr/bin/vm_stat').length, overviewExtras ? 1 : 0);
            if (overviewExtras) assert(result.sample.memory.composition, 'Every Overview memory read must include its measured composition');
        }
        last = result;
        await wait(2000);
    }
    console.log(JSON.stringify({ platform: process.platform, node: process.version, helper: executablePath, timingsMs: timings, readerCpuMicros: cpuMicros, spawns, sample: last?.sample, host: last?.host, processMemory: process.memoryUsage() }));
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
