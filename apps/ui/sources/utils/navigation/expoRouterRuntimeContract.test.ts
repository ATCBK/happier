import { describe, expect, it } from 'vitest';

import { loadInstalledExpoRuntimeRouter } from '@/dev/testkit/runtime/installedExpoRuntimeRouter';

const state = { key: 'root-stack', type: 'stack', index: 0, routes: [{ name: 'index' }] };
const config = { screens: { index: '', settings: 'settings/:section', session: 'session/:id', '+not-found': '*' } };

describe('installed Expo dynamic runtime navigation contract', () => {
    it.each([
        ['push', 'PUSH'], ['navigate', 'NAVIGATE'], ['replace', 'REPLACE'],
    ] as const)('keeps the SDK %s operation and unknown internal route handling', async (method, actionType) => {
        const sdk = await loadInstalledExpoRuntimeRouter({ state, config });
        sdk.router[method]('/future/route?value=a%26b#anchor');
        expect(sdk.actions).toEqual([]);
        sdk.flush();
        expect(sdk.resolvedPaths).toEqual(['/future/route?value=a%26b#anchor']);
        expect(sdk.actions).toEqual([expect.objectContaining({
            type: actionType, target: 'root-stack', payload: expect.objectContaining({ name: '+not-found' }),
        })]);
    });

    it('keeps object parameter encoding in the installed serializer', async () => {
        const sdk = await loadInstalledExpoRuntimeRouter({ state, config });
        sdk.router.replace({ pathname: '/session/[id]', params: { id: 'part/42', returnTo: '/settings?x=a&b' } });
        sdk.flush();
        expect(sdk.resolvedPaths).toEqual(['/session/part%2F42?returnTo=%2Fsettings%3Fx%3Da%26b']);
        expect(sdk.actions).toEqual([expect.objectContaining({
            type: 'REPLACE', payload: expect.objectContaining({ name: 'session', params: expect.objectContaining({
                id: 'part/42', returnTo: '/settings?x=a&b',
            }) }),
        })]);
    });

    it('keeps relative document resolution and parent-back semantics', async () => {
        const sdk = await loadInstalledExpoRuntimeRouter({
            state, config, routeInfo: { segments: ['settings', '[section]'], params: { section: 'old' } },
        });
        sdk.router.push('./new?value=a%26b');
        sdk.flush();
        expect(sdk.resolvedPaths).toEqual(['/settings/new?value=a%26b']);
        sdk.router.replace('..');
        expect(sdk.backCount).toBe(1);
        expect(sdk.actions).toHaveLength(1);
    });

    it('retains external URL handling instead of dispatching an internal action', async () => {
        const sdk = await loadInstalledExpoRuntimeRouter({ state, config });
        sdk.router.push('https://example.test/path?value=a%26b');
        sdk.flush();
        expect(sdk.openedUrls).toEqual(['https://example.test/path?value=a%26b']);
        expect(sdk.actions).toEqual([]);
    });

    it('retains the SDK readiness failure at queue execution', async () => {
        const sdk = await loadInstalledExpoRuntimeRouter({ state, config, ready: false });
        sdk.router.replace('/settings/general');
        expect(() => sdk.flush()).toThrow('Attempted to navigate before mounting the Root Layout');
        expect(sdk.actions).toEqual([]);
    });
});
