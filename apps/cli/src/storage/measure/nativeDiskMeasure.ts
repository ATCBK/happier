import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { z } from 'zod';
import { createHappierTempDir, removeHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';

import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';

const bytes = z.number().int().nonnegative().safe();
const flags = z.object({ atLeast: z.boolean(), sharedExtentsUnmeasured: z.boolean().optional() }).strict();
const allocationFact = z.object({ key: z.string().min(1), allocatedBytes: bytes, pathId: z.string(),
    mtimeMs: z.number().int().safe(), ageIncluded: z.boolean() }).strict();
const measuredPath = z.object({
    path: z.string(),
    allocatedBytes: bytes,
    exclusiveBytes: bytes,
    freesUpToBytes: bytes.optional(),
    sharedBytes: bytes,
    sharedExtentsUnmeasured: z.boolean(),
    items: bytes,
    atLeast: z.boolean(),
    lastChangedAtMs: z.number().int().safe().positive().optional(),
}).strict();
const measurement = z.object({
    v: z.literal(1),
    perPath: z.array(measuredPath),
    totalAllocatedBytes: bytes,
    totalExclusiveBytes: bytes,
    unions: z.array(z.object({ id: z.string().min(1), totalAllocatedBytes: bytes, totalExclusiveBytes: bytes,
        atLeast: z.boolean() }).strict()).optional(),
}).strict();

const scanNode = z.object({
    id: z.string(),
    name: z.string(),
    nameBytes: z.string().optional(),
    kind: z.enum(['folder', 'file', 'symlink', 'mount', 'cloud-only', 'package', 'other']),
    allocatedBytes: bytes,
    logicalBytes: bytes,
    items: bytes,
    mtimeMs: z.number().int().safe(),
    flags,
    allocationFacts: z.array(allocationFact).optional(),
}).strict();
const directory = z.object({
    v: z.literal(1),
    type: z.literal('dir'),
    ownLogicalBytes: bytes.optional(),
    id: z.string(),
    parent: z.string().optional(),
    name: z.string(),
    nameBytes: z.string().optional(),
    allocatedBytes: bytes,
    logicalBytes: bytes,
    items: bytes,
    mtimeMs: z.number().int().safe(),
    flags,
    allocationFacts: z.array(allocationFact).optional(),
    children: z.array(scanNode),
    files: z.array(scanNode),
    folded: z.object({ items: bytes, allocatedBytes: bytes, logicalBytes: bytes }).strict(),
    ageGroupBytes: z.object({ unknown: bytes, months3: bytes, months6: bytes, months12: bytes }).strict(),
    complete: z.boolean(),
    /** Entries and physical facts arrived separately; this record contains aggregates only. */
    streamed: z.literal(true).optional(),
    /** The directory's complete direct-name enumeration, independent of subtree coverage. */
    enumerated: z.boolean().optional(),
    /** Verified developer tree: aggregate directory, with ordinary file queries retained. */
    summarized: z.literal(true).optional(),
    /** Direct relist names, before chart folding; [] authoritatively lists an empty folder. */
    directChildIds: z.array(z.string()).optional(),
    /** Cached physical child subtrees reused without renewing their coverage. */
    retainedSubtrees: z.array(z.string()).optional(),
}).strict();
const directoryStart = directory.omit({ directChildIds: true, retainedSubtrees: true }).extend({
    type: z.literal('dir-start'), streamed: z.literal(true), relistOnly: z.boolean(),
    children: z.tuple([]), files: z.tuple([]), allocationFacts: z.tuple([]).optional(),
});
const directoryEntry = z.object({
    v: z.literal(1), type: z.literal('dir-entry'), parent: z.string(),
    node: scanNode.omit({ allocationFacts: true }), visible: z.boolean(), retained: z.boolean(), replaceFacts: z.boolean(),
}).strict();
const physicalFact = z.object({ v: z.literal(1), type: z.literal('fact'), owner: z.string(), fact: allocationFact }).strict();
const progress = z.object({
    v: z.literal(1),
    type: z.literal('progress'),
    sizedBytes: bytes,
    items: bytes,
    currentPath: z.string().optional(),
    stuckSinceMs: bytes.optional(),
    fraction: z.number().min(0).max(1).optional(),
}).strict();
const summary = z.object({
    v: z.literal(1),
    type: z.literal('summary'),
    termination: z.enum(['completed', 'cancelled', 'interrupted', 'failed']),
    unreadable: z.array(z.object({ path: z.string(), reason: z.enum(['permission', 'os_private', 'timeout', 'io']) }).strict()),
    unreadableCounts: z.object({ permission: bytes, os_private: bytes, timeout: bytes, io: bytes }).strict(),
    skipped: z.array(z.object({ path: z.string(), reason: z.string() }).strict()),
    backendByDirCounts: z.record(z.string(), bytes),
    allocatedBytes: bytes,
    items: bytes,
    pendingFrontier: z.array(z.string()).optional(),
    streamedFrontier: z.literal(true).optional(),
}).strict();
const frontierStart = z.object({ v: z.literal(1), type: z.literal('frontier-start') }).strict();
const frontierItem = z.object({ v: z.literal(1), type: z.literal('frontier-item'), path: z.string() }).strict();
const permission = z.object({
    v: z.literal(1),
    type: z.literal('permission'),
    fullDiskAccess: z.object({
        state: z.enum(['unknown', 'not_granted', 'granted', 'not_applicable']),
        binary: z.object({ name: z.string().min(1), path: z.string().min(1) }).strict(),
        waitingForConsent: z.boolean(),
    }).strict(),
}).strict();
const scanRecord = z.discriminatedUnion('type', [directory, directoryStart, directoryEntry, physicalFact, frontierStart, frontierItem, progress, summary, permission])
    .superRefine((record, context) => {
        if (record.type === 'dir' && record.streamed && (record.children.length || record.files.length
            || record.allocationFacts?.length || record.directChildIds !== undefined || record.retainedSubtrees !== undefined)) {
            context.addIssue({ code: 'custom', message: 'Streamed directory aggregates cannot carry entry arrays' });
        }
        if (record.type === 'summary' && record.streamedFrontier && record.pendingFrontier?.length) {
            context.addIssue({ code: 'custom', message: 'Streamed frontier cannot carry a second frontier array' });
        }
    });
const invalidIndexDiagnostic = z.object({
    v: z.literal(1),
    code: z.literal('native_disk_invalid_previous_index'),
    message: z.string(),
}).strict();

export type NativeDiskMeasurement = z.infer<typeof measurement>;
export type NativeDiskScanRecord = z.infer<typeof scanRecord>;
export type NativeDiskScanSummary = z.infer<typeof summary>;
export type NativeDiskMeasureRequest = Readonly<{
    paths: readonly string[];
    /** Additional distinct reclaimability sets, evaluated by the same physical walk. */
    unions?: readonly Readonly<{ id: string; paths: readonly string[]; excludeIncomplete?: boolean }>[];
    /** Only pile review asks the Linux backend to measure shared extents. */
    measureSharedExtents?: boolean;
    lowPower?: boolean;
}>;
export type NativeDiskScanRequest = Readonly<{
    root: string;
    /** Refresh only root's direct entries, retaining matching indexed child subtrees. */
    relistOnly?: boolean;
    /** Transient prior-dir/prior-observation/prior-child NDJSON from the SQLite index owner. */
    previousIndexPath?: string;
    /** Pending directory frontier. The caller merges invocation-only totals into its retained index. */
    resumeFrom?: readonly string[];
    /** Same interrupted scan's retained Skip boundaries; never fresh-scan exclusions. */
    skippedPaths?: readonly string[];
    priorityHints?: readonly string[];
    atomicRules?: readonly Readonly<{ names?: readonly string[]; manifests?: readonly string[]; parentName?: string;
        manifestParentLevel?: number; paths?: readonly string[] }>[];
    keepMinBytes?: number;
    lowPower?: boolean;
    drawableNodes?: number;
    usedBytes?: number;
    /** Only the canonical volume facts may allow sibling APFS container devices. */
    allowedDevices?: readonly string[];
}>;
export type NativeDiskScan = Readonly<{
    /** Exact-helper PID for resource observations; absent if spawning failed. */
    pid?: number;
    done: Promise<NativeDiskScanSummary>;
    skip(path: string): void;
    cancel(): void;
}>;

function aborted(): Error {
    return Object.assign(new Error('Native disk operation cancelled'), { name: 'AbortError' });
}

function invalidOutput(cause: unknown): Error {
    return Object.assign(new Error('Invalid native disk output', { cause }), { code: 'invalid_native_disk_output' });
}

function consumerFailed(cause: unknown): Error {
    return Object.assign(new Error('Native disk scan consumer failed', { cause }), { code: 'native_disk_consumer_failed' });
}

/**
 * The helper owns enumeration and measurement; this adapter holds only the current
 * NDJSON line. Directory consumers persist synchronously rather than collecting a
 * tree in the daemon. Cancellation retires this one process and waits for close.
 */
function runNativeDisk<T>(input: Readonly<{
    command: 'disk-measure' | 'disk-scan';
    request: NativeDiskMeasureRequest | (NativeDiskScanRequest & Readonly<{ scratchDirectory: string }>);
    signal?: AbortSignal;
    onRecordBatch?: (consume: () => void) => void;
    record(line: unknown): void;
    result(): T;
}>): Readonly<{ pid?: number; done: Promise<T>; send(message: unknown): void; cancel(): void }> {
    if (input.signal?.aborted) throw aborted();
    const executable = process.platform === 'win32' && process.arch === 'arm64'
        ? null
        : resolveProcessCustodySupportExecutable();
    if (!executable) {
        throw Object.assign(new Error('Native disk measurement is unavailable on this machine'), { code: 'native_disk_unavailable' });
    }
    const child = spawn(executable, [input.command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stderr = '';
    let failure: Error | undefined;
    let closed = false;
    const fail = (error: Error) => {
        if (failure) return;
        failure = error;
        if (!closed) child.kill('SIGKILL');
    };
    const cancel = () => fail(aborted());
    const readLine = (line: string) => {
        if (failure || !line.trim()) return;
        try {
            input.record(JSON.parse(line));
        } catch (error) {
            fail(error instanceof Error && 'code' in error ? error : invalidOutput(error));
        }
    };
    const consumeBatch = (consume: () => void) => {
        try {
            if (input.onRecordBatch) input.onRecordBatch(() => {
                consume();
                // Parsing catches errors to retire the child safely. Expose that
                // failure to the surrounding SQLite transaction so it rolls back.
                if (failure) throw failure;
            });
            else consume();
        } catch (cause) { fail(failure && cause === failure ? failure : consumerFailed(cause)); }
    };
    const done = new Promise<T>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
            if (failure) return;
            consumeBatch(() => {
                pending += decoder.write(chunk);
                let newline: number;
                while ((newline = pending.indexOf('\n')) !== -1) {
                    const line = pending.slice(0, newline);
                    pending = pending.slice(newline + 1);
                    readLine(line);
                    if (failure) break;
                }
            });
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        child.stdout.on('error', fail);
        child.stderr.on('error', fail);
        child.stdin.on('error', fail);
        child.on('error', (error) => { failure ??= error; });
        child.on('close', (code, signal) => {
            closed = true;
            input.signal?.removeEventListener('abort', cancel);
            if (!failure) {
                consumeBatch(() => { pending += decoder.end(); readLine(pending); });
            }
            if (failure) { reject(failure); return; }
            if (code !== 0) {
                // Only the native owner decides invalid prior input. Other diagnostics
                // retain their existing generic failure contract, including malformed JSON.
                let invalidIndex: z.infer<typeof invalidIndexDiagnostic> | undefined;
                try {
                    const parsed = invalidIndexDiagnostic.safeParse(JSON.parse(stderr.trim()));
                    if (parsed.success) invalidIndex = parsed.data;
                } catch { /* Ordinary native diagnostics are plain text. */ }
                if (invalidIndex) {
                    reject(Object.assign(new Error(invalidIndex.message), {
                        code: invalidIndex.code, exitCode: code, signal,
                    }));
                    return;
                }
                reject(Object.assign(new Error(stderr.trim() || 'Native disk operation failed'), {
                    code: 'native_disk_failed', exitCode: code, signal,
                }));
                return;
            }
            try { resolve(input.result()); }
            catch (error) { reject(invalidOutput(error)); }
        });
    });
    input.signal?.addEventListener('abort', cancel, { once: true });
    // Recheck after listener registration so abort cannot race process creation.
    if (input.signal?.aborted) cancel();
    if (!failure) {
        child.stdin.write(JSON.stringify(input.request) + '\n');
        if (input.command === 'disk-measure') child.stdin.end();
    }
    return {
        pid: child.pid,
        done,
        cancel,
        send(message) {
            if (closed || failure) return;
            child.stdin.write(JSON.stringify(message) + '\n');
        },
    };
}

export async function measureNativeDisk(
    request: NativeDiskMeasureRequest,
    options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<NativeDiskMeasurement> {
    let result: NativeDiskMeasurement | undefined;
    return runNativeDisk({
        command: 'disk-measure', request, signal: options.signal,
        record(line) {
            if (result) throw invalidOutput('duplicate measurement');
            result = measurement.parse(line);
        },
        result() {
            if (!result) throw new Error('Missing native disk measurement');
            return result;
        },
    }).done;
}

export function startNativeDiskScan(
    request: NativeDiskScanRequest,
    options: Readonly<{ signal?: AbortSignal; onRecord: (record: NativeDiskScanRecord) => void;
        /** Immediate OS stdout chunk; lets SQLite commit once without collecting records. */
        onRecordBatch?: (consume: () => void) => void }>,
): NativeDiskScan {
    if (options.signal?.aborted) throw aborted();
    // The host's marked temporary owner outlives this child, including SIGKILL.
    // Spools are never a persistent index and callers cannot select their path.
    const scratchDirectory = createHappierTempDir({ purpose: 'storage-scan' });
    let terminal: NativeDiskScanSummary | undefined;
    let operation: ReturnType<typeof runNativeDisk<NativeDiskScanSummary>>;
    try {
        operation = runNativeDisk({
            command: 'disk-scan', request: { ...request, scratchDirectory }, signal: options.signal, onRecordBatch: options.onRecordBatch,
            record(line) {
                if (terminal) throw invalidOutput('record after terminal summary');
                const parsed = scanRecord.parse(line);
                if (parsed.type === 'summary') terminal = parsed;
                try { options.onRecord(parsed); }
                catch (cause) {
                    throw consumerFailed(cause);
                }
            },
            result() {
                if (!terminal) throw new Error('Missing native disk scan summary');
                return terminal;
            },
        });
    } catch (error) { removeHappierTempDir(scratchDirectory); throw error; }
    return { pid: operation.pid, done: operation.done.finally(() => removeHappierTempDirAsync(scratchDirectory)),
        cancel: operation.cancel, skip: (path) => operation.send({ type: 'skip', path }) };
}
