import { z } from 'zod';
import type { ProcessCensusSnapshot } from './processCensus';

const unsigned = z.number().int().nonnegative().safe();
const principal = z.object({ kind: z.enum(['uid', 'sid']), value: z.string().min(1) }).strict();
const ownershipEnvironment = z.object({
    HAPPIER_HOME_DIR: z.string().optional(), HAPPIER_ACTIVE_SERVER_ID: z.string().optional(),
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: z.string().optional(), HAPPIER_SERVER_URL: z.string().optional(),
    HAPPIER_WEBAPP_URL: z.string().optional(), HAPPIER_PUBLIC_SERVER_URL: z.string().optional(),
}).strict();
const rowSchema = z.object({
    pid: unsigned.positive(), ppid: unsigned.nullable(), pgid: z.number().int().safe().optional(), sessionId: unsigned.positive().optional(),
    start: z.object({ startTimeMs: unsigned, native: z.string().optional() }).strict(),
    principal: principal.nullable(), name: z.string(),
    executablePath: z.string().optional(), argv: z.array(z.string()).optional(), commandLine: z.string().optional(),
    cwd: z.string().optional(), ownerTag: z.string().optional(), ownershipEnvironment: ownershipEnvironment.optional(),
    memory: z.object({ bytes: unsigned, kind: z.enum(['rss', 'footprint', 'private', 'working_set']) }).strict().nullable(),
    cpuTimeUs: unsigned.nullable(), cgroup: z.string().optional(), jobs: z.array(z.string()).optional(),
    state: z.enum(['running', 'sleeping', 'stopped', 'zombie', 'other']).optional(), tpgid: z.number().int().safe().optional(),
}).strict();
const helperSchema = z.object({
    v: z.literal(1), capturedAtMs: unsigned, logicalCpus: unsigned.positive(), rows: z.array(rowSchema),
    partial: z.array(z.object({ pid: unsigned, missing: z.array(z.string()) }).strict()).optional(),
    jobObservations: z.array(z.discriminatedUnion('state', [
        z.object({ name: z.string().min(1), state: z.literal('live'), pids: z.array(unsigned.positive()).min(1) }).strict(),
        z.object({ name: z.string().min(1), state: z.literal('absent'), pids: z.array(unsigned.positive()).max(0).optional() }).strict(),
        z.object({ name: z.string().min(1), state: z.literal('unavailable') }).strict(),
    ])).optional(),
}).strict();

export function decodeHelperCensus(output: string, selfPid: number, verifiedJobNames?: readonly string[]): ProcessCensusSnapshot {
    try {
        const decoded = helperSchema.safeParse(JSON.parse(output));
        if (!decoded.success) return { status: 'unavailable', reason: 'read_failed' };
        const data = decoded.data;
        const observed = new Set<string>();
        for (const job of data.jobObservations ?? []) {
            if (observed.has(job.name) || (job.state === 'live' && new Set(job.pids).size !== job.pids.length)) return { status: 'unavailable', reason: 'read_failed' };
            observed.add(job.name);
        }
        if (verifiedJobNames && (observed.size !== verifiedJobNames.length || verifiedJobNames.some(name => !observed.has(name)))) return { status: 'unavailable', reason: 'read_failed' };
        const self = data.rows.find(row => row.pid === selfPid);
        if (!self) return { status: 'unavailable', reason: 'self_absent' };
        const seen = new Set<number>();
        for (const row of data.rows) {
            if (seen.has(row.pid)) return { status: 'unavailable', reason: 'read_failed' };
            seen.add(row.pid);
            const own = row.principal !== null && self.principal !== null
                && row.principal.kind === self.principal.kind && row.principal.value === self.principal.value;
            if (!own && (row.argv !== undefined || row.commandLine !== undefined || row.cwd !== undefined
                || row.executablePath !== undefined || row.ownerTag !== undefined || row.ownershipEnvironment !== undefined)) {
                return { status: 'unavailable', reason: 'read_failed' };
            }
        }
        return { status: 'ok', capturedAtMs: data.capturedAtMs, logicalCpus: data.logicalCpus, rows: data.rows,
            ...(data.jobObservations ? { jobObservations: data.jobObservations } : {}),
            ...(data.partial ? { partial: data.partial } : {}) };
    } catch {
        return { status: 'unavailable', reason: 'read_failed' };
    }
}
