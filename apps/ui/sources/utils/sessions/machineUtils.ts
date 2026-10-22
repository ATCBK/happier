import { DEFAULT_MACHINE_ONLINE_GRACE_MS, isMachineOnlineV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';

let cachedGraceEnvRaw: string | null = null;
let cachedGraceEnvMs: number = DEFAULT_MACHINE_ONLINE_GRACE_MS;

export function readMachineOnlineGraceMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS ?? '').trim();
    if (raw === cachedGraceEnvRaw) return cachedGraceEnvMs;

    // Must exceed the daemon keep-alive interval to avoid presence flicker.
    if (!raw) {
        cachedGraceEnvRaw = raw;
        cachedGraceEnvMs = DEFAULT_MACHINE_ONLINE_GRACE_MS;
        return cachedGraceEnvMs;
    }
    const parsed = Number.parseInt(raw, 10);
    const graceMs = !Number.isFinite(parsed)
        ? DEFAULT_MACHINE_ONLINE_GRACE_MS
        : Math.max(0, parsed);

    cachedGraceEnvRaw = raw;
    cachedGraceEnvMs = graceMs;
    return cachedGraceEnvMs;
}

export function isMachineOnline(
    machine: Readonly<{
        active: boolean;
        activeAt?: number | null;
        revokedAt?: number | null;
    }>,
    nowMs: number = Date.now(),
): boolean {
    return isMachineOnlineV1(machine, nowMs, readMachineOnlineGraceMsFromEnv());
}

/** Next presentation change from these presence facts, using the same grace owner as online status. */
export function readMachineStatusNextRefreshAtMs(
    machine: Parameters<typeof isMachineOnline>[0],
    nowMs: number,
): number | null {
    if (!isMachineOnline(machine, nowMs)) return null;
    const graceMs = readMachineOnlineGraceMsFromEnv();
    const activeAt = machine.activeAt;
    if (graceMs <= 0 || typeof activeAt !== 'number' || !Number.isFinite(activeAt) || activeAt === 0) return null;
    const expiresAtMs = activeAt + graceMs + 1;
    return expiresAtMs > nowMs ? expiresAtMs : null;
}

export type MachinePresenceCounts = Readonly<{ online: number; offline: number; unknown: number }>;

export { getMachineDisplayName, resolveMachineDisplayNames } from './machineDisplayNames';
