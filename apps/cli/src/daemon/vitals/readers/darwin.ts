import { execFileWithDeadline, parseDarwinBatteryFacts } from '@happier-dev/cli-common/process';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { parseDarwinGpu, parseDarwinHardwarePorts, parseDarwinThermal, parseDarwinVmStat } from './darwinParsers';
import { createDarwinVolumeCapacityReader } from './darwinPurgeable';
import { createNativeMachineVitalsReader, type NativeMachineVitalsReaderOptions } from './native';

export function createDarwinMachineVitalsReader(options: NativeMachineVitalsReaderOptions = {}) {
    const core = createNativeMachineVitalsReader('darwin', options);
    const run = options.execFile ?? execFileWithDeadline;
    const readVolumeCapacities = createDarwinVolumeCapacityReader(options);
    let hardwarePorts: Map<string, string> | undefined;
    let extrasAt = -Infinity;
    let powerMinute: number | undefined;
    let powerFacts: ReturnType<typeof parseDarwinBatteryFacts> = { present: false };
    let extras: Pick<MachineVitalsSampleV1, 'battery' | 'thermal' | 'gpu'> = {};
    const tool = async (command: string, args: string[]) => {
        try { return String((await run(command, args, { encoding: 'utf8', signal: options.signal })).stdout); } catch { return ''; }
    };
    return {
        readVolumeCapacities,
        read: async (input: Parameters<typeof core.read>[0]) => {
            const result = await core.read(input);
            if (result.state !== 'reporting') return result;
            // Static display names are read once, never at the sampling cadence.
            hardwarePorts ??= parseDarwinHardwarePorts(await tool('/usr/sbin/networksetup', ['-listallhardwareports']));
            const sample = result.sample;
            if (input.overview && sample.memory.reported) {
                const vmStat = await tool('/usr/bin/vm_stat', []);
                const composition = parseDarwinVmStat(vmStat, sample.memory.usedBytes);
                if (composition) sample.memory.composition = composition;
            }
            const readExtras = input.overviewExtras && (input.monotonicMs < extrasAt || input.monotonicMs - extrasAt >= 15_000);
            // Policy consumers share a minute power observation; Overview reuses
            // this reader at its extras boundary. Cadence alone creates no demand.
            const minute = Math.floor(input.sampledAt / 60_000);
            if (input.power && powerMinute !== minute || readExtras) {
                powerMinute = minute;
                powerFacts = parseDarwinBatteryFacts(await tool('/usr/bin/pmset', ['-g', 'batt']));
            }
            if ((input.power || readExtras) && powerFacts.onAC !== undefined) sample.power = { onAC: powerFacts.onAC };
            if (sample.network.reported) {
                for (const iface of sample.network.interfaces ?? []) iface.label = hardwarePorts.get(iface.label) ?? iface.label;
                if (sample.network.label) sample.network.label = hardwarePorts.get(sample.network.label) ?? sample.network.label;
            }
            if (input.overviewExtras) {
                if (readExtras) {
                    extrasAt = input.monotonicMs;
                    const [thermal, gpu] = await Promise.all([
                        tool('/usr/bin/pmset', ['-g', 'therm']), tool('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']),
                    ]);
                    extras = { battery: powerFacts.battery, thermal: parseDarwinThermal(thermal), gpu: parseDarwinGpu(gpu) };
                }
                if (sample.disk.reported) sample.disk.volumes = await readVolumeCapacities({ volumes: sample.disk.volumes, monotonicMs: input.monotonicMs });
                if (extras.battery) sample.battery = extras.battery;
                if (extras.thermal) sample.thermal = extras.thermal;
                if (extras.gpu) sample.gpu = extras.gpu;
            }
            return result;
        },
    };
}
