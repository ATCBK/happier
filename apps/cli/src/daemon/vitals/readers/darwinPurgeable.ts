import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';

type Volume = Extract<MachineVitalsSampleV1['disk'], { reported: true }>['volumes'][number];
const script = `ObjC.import('Foundation'); function run(argv) {
    var url = $.NSURL.fileURLWithPath(argv[0]); var value = Ref(); var error = Ref();
    if (!url.getResourceValueForKeyError(value, $.NSURLVolumeAvailableCapacityForImportantUsageKey, error)) throw Error('Capacity unavailable');
    return String(ObjC.unwrap(value[0]));
}`;

/** One capacity owner for Overview and Storage; free-now bytes remain untouched. */
export function createDarwinVolumeCapacityReader(options: { execFile?: ProcessCustodyExecFile; signal?: AbortSignal } = {}) {
    const cached = new Map<string, { at: number; availableIncludingPurgeableBytes?: number }>();
    const run = options.execFile ?? execFileWithDeadline;
    return async (input: { volumes: readonly Volume[]; monotonicMs: number }): Promise<Volume[]> => {
        const ids = new Set(input.volumes.map((volume) => volume.id));
        for (const id of cached.keys()) if (!ids.has(id)) cached.delete(id);
        return await Promise.all(input.volumes.map(async (volume) => {
            if (!volume.apfsContainerId) return volume;
            let entry = cached.get(volume.id);
            if (!entry || input.monotonicMs < entry.at || input.monotonicMs - entry.at >= 60_000) {
                entry = { at: input.monotonicMs };
                cached.set(volume.id, entry);
                try {
                    const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, volume.mount], { encoding: 'utf8', signal: options.signal });
                    const text = String(result.stdout).trim();
                    const value = Number(text);
                    if (/^\d+$/.test(text) && Number.isSafeInteger(value) && value >= volume.availableBytes) entry.availableIncludingPurgeableBytes = value;
                } catch { /* An unavailable public estimate leaves its segment absent. */ }
            }
            return entry.availableIncludingPurgeableBytes !== undefined && entry.availableIncludingPurgeableBytes >= volume.availableBytes
                ? { ...volume, availableIncludingPurgeableBytes: entry.availableIncludingPurgeableBytes } : volume;
        }));
    };
}
