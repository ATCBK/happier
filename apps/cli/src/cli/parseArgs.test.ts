import { describe, expect, it } from 'vitest';

import { normalizeCliArgv, parseCliArgs, readCliProcessArgs } from './parseArgs';

describe('parseCliArgs', () => {
    it.each([
        ['bun', 'C:\\runtime\\index.exe', 'C:\\runtime\\package-dist\\index.mjs', '--version'],
        ['node', '/repo/apps/cli/bin/happier-dev.mjs', 'src/index.ts', '-v'],
    ])('normalizes the extra runtime entrypoint before root flags: %j', (...argv) => {
        expect(readCliProcessArgs(argv)).toEqual([argv.at(-1)]);
    });

    it('strips a leading packaged runtime entrypoint before parsing command args', () => {
        expect(
            parseCliArgs([
                '/Users/test/.happier/stacks/review-runs/runtime/builds/abc123/cli/package-dist/index.mjs',
                'daemon',
                'start-sync',
            ]),
        ).toEqual({
            args: ['daemon', 'start-sync'],
            terminalRuntime: null,
        });
    });

    it('strips a leading relative source entrypoint used by the dev script', () => {
        expect(normalizeCliArgv(['src/index.ts', 'agents', 'status', '--json'])).toEqual([
            'agents',
            'status',
            '--json',
        ]);
        expect(normalizeCliArgv(['apps/cli/src/index.ts', 'agents', 'status'])).toEqual([
            'agents',
            'status',
        ]);
    });

    it('strips runtime context before command flags but leaves provider arguments alone', () => {
        const payload = Buffer.from(JSON.stringify({ HAPPIER_HOME_DIR: '/sentinel' })).toString('base64url');
        expect(parseCliArgs(['src/index.ts', '--runtime-context', payload, 'resume', 'session-sentinel']).args)
            .toEqual(['resume', 'session-sentinel']);
        expect(parseCliArgs(['agent-sentinel', '--runtime-context', 'provider-value']).args)
            .toEqual(['agent-sentinel', '--runtime-context', 'provider-value']);
    });
});
