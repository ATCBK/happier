import { describe, expect, it } from 'vitest';

import {
    decodeDatabaseRow,
    decodeDatabaseValue,
    decodeLineFrames,
    decodeResponse,
    encodeDatabaseRow,
    encodeLine,
} from './daemonDatabaseWorkerProtocol';
import { PluginContextServiceError } from './errors';

describe('daemon database worker protocol', () => {
    it('preserves binary and bigint SQLite values across JSON wire frames', () => {
        const row = {
            text: 'record',
            empty: null,
            count: 3,
            integer: 9_007_199_254_740_993n,
            bytes: new Uint8Array([0, 128, 255]),
        };
        const frames: unknown[] = [];
        decodeLineFrames((frame) => frames.push(frame))(encodeLine({
            id: 'query-1',
            ok: true,
            result: { kind: 'row', row: encodeDatabaseRow(row) },
        }));
        const response = decodeResponse(frames[0]);
        expect(response.ok).toBe(true);
        if (!response.ok || response.result.kind !== 'row') throw new Error('Expected a row response');
        expect(decodeDatabaseRow(response.result.row)).toEqual(row);
    });

    it('retains fragmented frames and surfaces malformed JSON to protocol validation', () => {
        const frames: unknown[] = [];
        const receive = decodeLineFrames((frame) => frames.push(frame));
        receive(Buffer.from(' \n{"id":"open-1","ok":true,'));
        expect(frames).toEqual([]);
        receive(Buffer.from('"result":{"kind":"void"}}\nnot-json\n'));
        expect(decodeResponse(frames[0])).toEqual({ id: 'open-1', ok: true, result: { kind: 'void' } });
        expect(frames[1]).toBeNull();
        expect(() => decodeResponse(frames[1])).toThrow(expect.objectContaining({
            code: 'daemon_database_worker_protocol_invalid',
        }));
    });

    it('keeps canonical typed errors for invalid wire values and unsupported SQLite rows', () => {
        for (const value of [{ type: 'bigint', value: 'not-an-integer' }, { type: 'unknown' }]) {
            expect(() => decodeDatabaseValue(value)).toThrow(PluginContextServiceError);
            expect(() => decodeDatabaseValue(value)).toThrow(expect.objectContaining({
                code: 'daemon_database_worker_protocol_invalid',
            }));
        }
        expect(() => encodeDatabaseRow({ value: new Date(0) })).toThrow(expect.objectContaining({
            code: 'daemon_database_result_invalid',
        }));
        expect(() => decodeResponse({ id: 'open-1', ok: false, error: { message: 'unavailable', code: 1 } }))
            .toThrow(expect.objectContaining({ code: 'daemon_database_worker_protocol_invalid' }));
    });
});
