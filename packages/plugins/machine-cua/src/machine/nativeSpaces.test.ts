import { describe, expect, it, vi } from 'vitest';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';
import { readCuaSpaceRegistry, removeCuaSpaceRegistration } from './nativeSpaces.js';

function result(value: unknown, exitCode = 0): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
// Only the native process is replaced; both routes' registry reads share one decoder beneath it.
function harness(...results: PluginProcessResult[]) {
    const argv: string[][] = [];
    const run = vi.fn(async (request: { args?: readonly string[] }) => {
        argv.push([...(request.args ?? [])]);
        const next = results.shift();
        if (!next) throw new Error('Unexpected native command');
        return next;
    });
    return { argv, native: createCuaNativeClient({ exec: { run }, executable: { kind: 'systemTool', id: 'cua' } }) };
}

describe('created Space registry shared by the local and BYOC routes', () => {
    it('forgets a present entry and proves removal by reading the registry again', async () => {
        const h = harness(result({ spaces: [{ id: 'local:a', provider: 'local' }] }), result({ removed: true }), result({ spaces: [] }));
        expect(await removeCuaSpaceRegistration(h.native, 'local:a', undefined, 'local')).toBe('removed');
        expect(h.argv.map((args) => args.slice(2).join(' '))).toEqual(['spaces ls', 'spaces rm local:a', 'spaces ls']);
    });
    it('does not accept an acknowledgement, a foreign provider or an unreadable registry as absence', async () => {
        const stuck = harness(result({ spaces: [{ id: 'relay:a', provider: 'relay' }] }), result({}), result({ spaces: [{ id: 'relay:a', provider: 'relay' }] }));
        expect(await removeCuaSpaceRegistration(stuck.native, 'relay:a')).toBe('present');
        const foreign = harness(result({ spaces: [{ id: 'local:a', provider: 'imported' }] }));
        expect(await readCuaSpaceRegistry(foreign.native, 'local:a', undefined, 'local')).toBe('unknown');
        expect(foreign.argv).toHaveLength(1);
        const unreadable = harness(result('boom', 1));
        expect(await removeCuaSpaceRegistration(unreadable.native, 'local:a', undefined, 'local')).toBe('unknown');
        expect(unreadable.argv).toHaveLength(1);
    });
});
