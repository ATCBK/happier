import { describe, expect, it } from 'vitest';

import { loadInstalledExpoRuntimeRouter } from '@/dev/testkit/runtime/installedExpoRuntimeRouter';
import { admitInternalRouteHref } from './routeUtils';

const state = { key: 'root-stack', type: 'stack', index: 0, routes: [{ name: 'index' }] };
const config = { screens: { index: '', session: 'session/:id', '+not-found': '*' } };

describe('admitted dynamic destinations through installed Expo dispatch', () => {
    it('rejects unsafe paths before they can reach either internal dispatch or external URL opening', async () => {
        const sdk = await loadInstalledExpoRuntimeRouter({ state, config });
        for (const destination of ['https://example.test/session/42', '//example.test/session/42', '/session/%5c42', '/session/%0a42',
            { pathname: '//example.test/session/[id]', params: { id: '42' } }]) {
            expect(() => sdk.router.push(admitInternalRouteHref(destination))).toThrow();
        }
        sdk.flush();
        expect(sdk.actions).toEqual([]);
        expect(sdk.openedUrls).toEqual([]);
    });

    it('dispatches a dynamic path without decoding its already serialized query a second time', async () => {
        const sdk = await loadInstalledExpoRuntimeRouter({ state, config });
        const href = '/session/42?returnTo=%2Fsettings%3Fx%3Da%26b&literal=%252F#anchor';
        sdk.router.push(admitInternalRouteHref(href));
        sdk.flush();
        expect(sdk.resolvedPaths).toEqual([href]);
        expect(sdk.actions).toEqual([expect.objectContaining({ type: 'PUSH', payload: expect.objectContaining({
            name: 'session', params: expect.objectContaining({ id: '42', returnTo: '/settings?x=a&b', literal: '%2F' }),
        }) })]);
    });

    it('keeps pathname parameters with their values until Expo serializes them once', async () => {
        const sdk = await loadInstalledExpoRuntimeRouter({ state, config });
        sdk.router.replace(admitInternalRouteHref({ pathname: '/session/[id]', params: {
            id: 'part/42', returnTo: 'https://home.test/settings?x=a&b', literal: '%2F',
        } }));
        sdk.flush();
        expect(sdk.resolvedPaths).toEqual(['/session/part%2F42?returnTo=https%3A%2F%2Fhome.test%2Fsettings%3Fx%3Da%26b&literal=%252F']);
        expect(sdk.actions).toEqual([expect.objectContaining({ type: 'REPLACE', payload: expect.objectContaining({
            name: 'session', params: expect.objectContaining({ id: 'part/42', returnTo: 'https://home.test/settings?x=a&b', literal: '%2F' }),
        }) })]);
    });
});
