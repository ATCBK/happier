import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { StackRouter } from '@react-navigation/core';
import { expect, it } from 'vitest';

it('separates pending child hydration from genuinely stale navigation', async () => {
    const pending = StackRouter({}).getRehydratedState({ stale: true, routes: [{
        name: 'App', state: { stale: true, routes: [{ name: 'index' }] },
    }] }, { routeNames: ['App'], routeParamList: {}, routeGetIdList: {} });
    expect(pending.stale).toBe(false);
    expect(pending.routes[pending.index].state?.stale).toBe(true);

    // Execute the installed SDK diagnostic without loading unrelated native
    // adapters or replacing navigation logic. Console output is the boundary.
    const require = createRequire(import.meta.url);
    const source = await readFile(require.resolve('expo-router/build/global-state/router-store'), 'utf8');
    const signature = 'onStateChange(newState) {';
    const start = source.indexOf(signature);
    const end = source.indexOf('storeRef.current.state = newState;', start);
    if (start < 0 || end < 0) throw new Error('Installed Expo navigation diagnostic unavailable');
    const diagnose = new Function('newState', 'process', 'console', source.slice(start + signature.length, end));
    const errors: unknown[][] = [];
    const diagnostics: unknown[][] = [];
    const logging = { error: (...args: unknown[]) => errors.push(args), debug: (...args: unknown[]) => diagnostics.push(args) };
    diagnose(pending, { env: { NODE_ENV: 'development' } }, logging);
    expect(errors).toEqual([]);
    expect(diagnostics).toHaveLength(1);

    for (const state of [
        { stale: true, routes: [{ name: 'index' }] },
        { stale: false, index: 0, routes: [{ name: 'App', state: {
            key: 'mounted-app', stale: true, routes: [{ name: 'index' }],
        } }] },
    ]) {
        errors.length = 0;
        diagnostics.length = 0;
        diagnose(state, { env: { NODE_ENV: 'development' } }, logging);
        expect(errors).toHaveLength(1);
        expect(diagnostics).toEqual([]);
    }
});
