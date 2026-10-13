import { describe, expect, it } from 'vitest';

import { parsePluginManifest } from './manifest.js';

async function loadSourceManifest(packageName: string): Promise<unknown> {
    // The source module is the real manifest producer, loaded at the filesystem boundary.
    const source: { PLUGIN_MANIFEST: unknown } = await import(
        `../../plugins/${packageName}/src/manifest.ts`
    );
    return source.PLUGIN_MANIFEST;
}

describe('first-party channel manifest admission', () => {
    it.each(['channel-email', 'channel-telegram', 'channel-discord', 'scm-github'])(
        'admits the real %s source manifest through the public parser',
        async (packageName) => {
            const parsed = parsePluginManifest(await loadSourceManifest(packageName));
            expect(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toBe(true);
        },
    );

    it('rejects a malformed service arm in a real credential-select declaration', async () => {
        const parsed = parsePluginManifest(await loadSourceManifest('channel-telegram'));
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const actions = parsed.manifest.contributes.actions ?? [];
        const action = actions.find((candidate) => (
            candidate.inputSchema?.properties?.credentialRef?.properties?.service !== undefined
        ));
        const credentialRef = action?.inputSchema?.properties?.credentialRef;
        const service = credentialRef?.properties?.service;
        if (!action || !credentialRef || !service) throw new Error('Expected the real account-select declaration');
        const malformed = parsePluginManifest({
            ...parsed.manifest,
            contributes: {
                ...parsed.manifest.contributes,
                actions: actions.map((candidate) => candidate !== action ? candidate : {
                    ...action,
                    inputSchema: {
                        ...action.inputSchema,
                        properties: {
                            ...action.inputSchema?.properties,
                            credentialRef: {
                                ...credentialRef,
                                properties: {
                                    ...credentialRef.properties,
                                    service: { anyOf: [service, { type: 'string' }] },
                                },
                            },
                        },
                    },
                }),
            },
        });
        expect(malformed.ok).toBe(false);
        if (malformed.ok) throw new Error('Malformed account selection was admitted');
        expect(malformed.diagnostics.some((diagnostic) => diagnostic.path?.includes('connectedAccountPurposeBindings') === true)).toBe(true);
        expect(malformed.diagnostics.some((diagnostic) => diagnostic.path?.includes('widget') === true)).toBe(true);
    });
});
