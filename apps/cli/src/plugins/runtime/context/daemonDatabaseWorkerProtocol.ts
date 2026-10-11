import type { DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';

import { PluginContextServiceError } from './errors';

// Parent and child share this wire owner without importing the CLI launcher
// into the SQLite child before it can acknowledge its first open request.
export type WireDatabaseValue =
    | null
    | string
    | number
    | Readonly<{ type: 'bigint'; value: string }>
    | Readonly<{ type: 'bytes'; base64: string }>;

type WireDatabaseRow = Readonly<Record<string, WireDatabaseValue>>;

export type DaemonDatabaseWorkerResultLimits = Readonly<{
    maximumResultBytes: number;
    maximumResultRows: number;
}>;

export type WorkerRequest =
    | Readonly<{ id: string; kind: 'open'; filePath: string }>
    | Readonly<{ id: string; kind: 'exec'; sql: string }>
    | Readonly<{ id: string; kind: 'get'; sql: string; values: readonly WireDatabaseValue[] }>
    | Readonly<{
        id: string;
        kind: 'all';
        sql: string;
        values: readonly WireDatabaseValue[];
        resultLimits: DaemonDatabaseWorkerResultLimits;
    }>
    | Readonly<{ id: string; kind: 'run'; sql: string; values: readonly WireDatabaseValue[] }>
    | Readonly<{ id: string; kind: 'close' }>;

export type WorkerResult =
    | Readonly<{ kind: 'void' }>
    | Readonly<{ kind: 'row'; row: WireDatabaseRow | null }>
    | Readonly<{ kind: 'rows'; rows: readonly WireDatabaseRow[]; changes: WireDatabaseValue }>
    | Readonly<{
        kind: 'run';
        changes: WireDatabaseValue | null;
        lastInsertRowId: WireDatabaseValue | null;
    }>;

export type WorkerResponse =
    | Readonly<{ id: string; ok: true; result: WorkerResult }>
    | Readonly<{ id: string; ok: false; error: Readonly<{ message: string; code: string | null }> }>;

export function workerProtocolError(): PluginContextServiceError {
    return new PluginContextServiceError(
        'daemon_database_worker_protocol_invalid',
        'SQLite database worker returned an invalid response',
    );
}

export function encodeDatabaseValue(value: DaemonDatabaseValue): WireDatabaseValue {
    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
    if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
    return { type: 'bytes', base64: Buffer.from(value).toString('base64') };
}

export function decodeDatabaseValue(value: unknown): DaemonDatabaseValue {
    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
    if (!isRecord(value) || typeof value.type !== 'string') throw workerProtocolError();
    if (value.type === 'bigint' && typeof value.value === 'string') {
        try {
            return BigInt(value.value);
        } catch {
            throw workerProtocolError();
        }
    }
    if (value.type === 'bytes' && typeof value.base64 === 'string') {
        return new Uint8Array(Buffer.from(value.base64, 'base64'));
    }
    throw workerProtocolError();
}

export function encodeDatabaseRow(value: unknown): WireDatabaseRow {
    if (!isRecord(value)) {
        throw new PluginContextServiceError('daemon_database_result_invalid', 'SQLite query returned an invalid row');
    }
    const row: Record<string, WireDatabaseValue> = Object.create(null);
    for (const [key, field] of Object.entries(value)) {
        row[key] = encodeDatabaseValue(assertDatabaseValue(field));
    }
    return row;
}

export function decodeDatabaseRow(value: unknown): Record<string, DaemonDatabaseValue> {
    if (!isRecord(value)) throw workerProtocolError();
    const row: Record<string, DaemonDatabaseValue> = Object.create(null);
    for (const [key, field] of Object.entries(value)) {
        row[key] = decodeDatabaseValue(field);
    }
    return row;
}

function assertDatabaseValue(value: unknown): DaemonDatabaseValue {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return value;
    }
    if (value instanceof Uint8Array) return value;
    throw new PluginContextServiceError('daemon_database_result_invalid', 'SQLite query returned an unsupported value');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function decodeResponse(value: unknown): WorkerResponse {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.ok !== 'boolean') throw workerProtocolError();
    if (value.ok) {
        if (!isRecord(value.result) || typeof value.result.kind !== 'string') throw workerProtocolError();
        return value as unknown as WorkerResponse;
    }
    if (!isRecord(value.error) || typeof value.error.message !== 'string') throw workerProtocolError();
    if (value.error.code !== null && typeof value.error.code !== 'string') throw workerProtocolError();
    return value as unknown as WorkerResponse;
}

export function decodeLineFrames(onFrame: (value: unknown) => void): (chunk: Buffer) => void {
    let buffered = '';
    return (chunk: Buffer) => {
        buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk).toString('utf8');
        while (true) {
            const newline = buffered.indexOf('\n');
            if (newline < 0) return;
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (!line.trim()) continue;
            try {
                onFrame(JSON.parse(line) as unknown);
            } catch {
                onFrame(null);
            }
        }
    };
}

export function encodeLine(value: unknown): Buffer {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}
