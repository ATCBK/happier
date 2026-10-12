import type { ProcessStartIdentity } from '@/processes/census/processCensus';

/** Identity only: every executor rechecks these native facts and current ownership. */
export function processRef(pid: number, start: ProcessStartIdentity): string {
    return Buffer.from(`${pid}:${start.startTimeMs}:${start.native ?? ''}`).toString('base64url');
}

export function decodeProcessRef(ref: string): Readonly<{ pid: number; start: ProcessStartIdentity }> | null {
    if (!/^[A-Za-z0-9_-]+$/u.test(ref)) return null;
    const decoded = Buffer.from(ref, 'base64url').toString('utf8');
    const match = /^(\d+):(\d+(?:\.\d+)?):(.*)$/u.exec(decoded);
    if (!match) return null;
    const pid = Number(match[1]);
    const startTimeMs = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(startTimeMs) || startTimeMs < 0) return null;
    const start = { startTimeMs, ...(match[3] ? { native: match[3] } : {}) };
    return processRef(pid, start) === ref ? { pid, start } : null;
}
