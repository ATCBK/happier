import { describe, expect, it } from 'vitest';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';
import { createCuaLocalSandbox } from './localSandbox.js';

const resource = { kind: 'sandbox', namespace: 'local', runtimeId: 'runc', sandboxId: 'local:owned' } as const;

function exited(exitCode: number): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
        stdout: new Uint8Array(), stderr: new TextEncoder().encode('cua: not found: sandbox owned'),
        stdoutTruncated: false, stderrTruncated: false };
}

// Only the native process boundary is replaced; the shared client and sandbox
// owner run for real.
function sandboxReturning(exitCode: number) {
    const argv: string[][] = [];
    const run = async (request: { args?: readonly string[] }) => { argv.push([...(request.args ?? [])]); return exited(exitCode); };
    return { argv, sandbox: createCuaLocalSandbox(createCuaNativeClient({ exec: { run }, executable: { kind: 'systemTool', id: 'cua' } })) };
}

describe('local Cua sandbox absence', () => {
    it('reads the native typed not-found exit as absence, so a finished delete can be confirmed', async () => {
        const h = sandboxReturning(3);
        expect(await h.sandbox.inspect(resource)).toMatchObject({ existence: 'absent' });
        expect(await h.sandbox.destroy(resource)).toMatchObject({ kind: 'deleted', existence: 'absent' });
        expect(h.argv.some(args => args.includes('rm'))).toBe(false);
    });

    it('does not read any other native failure as absence', async () => {
        const h = sandboxReturning(1);
        expect(await h.sandbox.inspect(resource)).toMatchObject({ existence: 'unknown' });
        expect(await h.sandbox.destroy(resource)).toMatchObject({ kind: 'unknown' });
    });
});
