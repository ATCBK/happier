import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

it('configures the hosted guest Mini core with English errors', async () => {
    vi.resetModules();
    const mini = await import('zod/mini');
    const previous = { ...mini.config() };
    mini.config({ customError: undefined, localeError: () => 'Mini locale missing' });
    try {
        await import('./configureZodLocale.js');
        const actual = mini.string().check(mini.minLength(3)).safeParse('ab');
        if (actual.success) throw new Error('The comparison input must be invalid');
        expect(actual.error.issues[0]?.message).toBe('Too small: expected string to have >=3 characters');
        expect(actual.error.issues[0]?.message).not.toBe('Mini locale missing');
    } finally {
        mini.config(previous);
    }
});

it('configures English in the independently bundled hosted guest before parsing', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../../..');
    const entry = resolve(import.meta.dirname, 'hostedHtmlGuestEntry.ts');
    const result = await build({
        absWorkingDir: repoRoot,
        entryPoints: [entry],
        bundle: true, write: false, minify: true, platform: 'browser', format: 'iife', target: ['es2022'],
        conditions: ['happier-source'],
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [
            { name: 'observe-guest-mini-error', setup(builder) {
                builder.onLoad({ filter: /hostedHtmlGuestEntry\.ts$/ }, async args => ({
                    contents: await readFile(args.path, 'utf8')
                        + "\nimport { z } from 'zod/mini'; globalThis.__happierGuestMiniIssue = z.string().check(z.minLength(3)).safeParse('ab').error?.issues[0]?.message;",
                    loader: 'ts', resolveDir: dirname(args.path),
                }));
            } },
            { name: 'workspace-protocol-source', setup(builder) {
                builder.onResolve({ filter: /^@happier-dev\/protocol(?:\/|$)/ }, args => {
                    if (args.pluginData?.workspaceProtocol) return;
                    return builder.resolve(args.path, { kind: args.kind, resolveDir: repoRoot,
                        pluginData: { workspaceProtocol: true } })
                        .then(resolved => ({ ...resolved, pluginData: undefined }));
                });
            } },
        ],
    });
    const realm = { window: {}, TextEncoder, TextDecoder, __happierGuestMiniIssue: undefined as string | undefined };
    runInNewContext(result.outputFiles[0].text, realm);
    expect(realm.__happierGuestMiniIssue).toBe('Too small: expected string to have >=3 characters');
});
