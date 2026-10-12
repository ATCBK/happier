import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { NewSessionHostParams } from './newSessionHost';
import { useNewSessionEmbeddedHostState } from './useNewSessionEmbeddedHostState';

const focusBoundary = vi.hoisted(() => ({ effects: new Set<() => void | (() => void)>() }));
vi.mock('@react-navigation/native', async () => {
    const React = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        // Navigation focus is the external boundary; the draft lifecycle stays real.
        useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(() => {
            focusBoundary.effects.add(effect);
            const cleanup = effect();
            return () => { focusBoundary.effects.delete(effect); cleanup?.(); };
        }, [effect]),
    };
});

it('keeps authored input during late context hydration and starts the next draft in that context after handoff', async () => {
    const seed: NewSessionHostParams = { spawnServerId: 'page-home', machineId: 'page-machine' };
    const hook = await renderHook((params: NewSessionHostParams) => useNewSessionEmbeddedHostState(params), { initialProps: seed });
    const firstDraftId = hook.getCurrent().host.params.draftId;
    await act(async () => hook.getCurrent().host.setParams({ directory: '/authored', prompt: 'my prompt' }));
    await hook.rerender({ ...seed, directory: '/home/page' });
    expect(hook.getCurrent().host.params.directory).toBe('/authored');
    expect(hook.getCurrent().host.params.prompt).toBe('my prompt');
    await act(async () => {
        hook.getCurrent().host.onHandedOff('/session/created');
        for (const effect of focusBoundary.effects) effect();
    });
    expect(hook.getCurrent().host.params).toMatchObject({ ...seed, directory: '/home/page' });
    expect(hook.getCurrent().host.params.draftId).not.toBe(firstDraftId);
    expect(hook.getCurrent().host.params.prompt).toBeUndefined();
    expect(hook.getCurrent().host.targetServerId).toBe('page-home');
    await hook.unmount();
});
