import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { Text } from '@/components/ui/text/Text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
afterEach(() => { standardCleanup(); });

const SCOPE = { serverId: 'home-1', accountId: 'account-1' };

it('carries a widget’s mark and state line, not its title alone, as Session cards do (lab wgdnd 1, F4 D-18)', async () => {
    const { useSessionSurfaceEntityDrag } = await import('./SessionSurfaceEntityDrag');
    const renderMark = (size: number) => <>{`mark:${size}`}</>;
    const drag = (await renderHook(() => useSessionSurfaceEntityDrag({
        scope: SCOPE, isCurrent: () => true, title: 'Period summary', subtitle: 'Account · Medium', renderMark,
        getItem: () => ({ kind: 'home-section', scope: SCOPE, sectionId: 'period' }),
    }))).getCurrent();
    expect(drag.runtime.describeSource(drag.sourceId)).toEqual({ title: 'Period summary', subtitle: 'Account · Medium', renderMark });
});

it('clears the surface-owned announcement when its real move settles without changing the admission', async () => {
    const { useSessionSurfaceEntityDrag, SessionSurfaceEntityFeedback } = await import('./SessionSurfaceEntityDrag');
    const receipt = createDeferred<void>();
    let drag: ReturnType<typeof useSessionSurfaceEntityDrag> | undefined;
    function Surface() {
        drag = useSessionSurfaceEntityDrag({ scope: SCOPE, isCurrent: () => true, title: 'Capacity',
            getItem: () => ({ kind: 'home-section', scope: SCOPE, sectionId: 'capacity' }),
            target: { acceptedKinds: ['home-section'], resolve: () => ({ status: 'allowed', effect: {
                actionId: 'home.hub.layout.update', input: { intent: { kind: 'move_to', sectionId: 'capacity',
                    position: { anchorId: 'start', placement: 'before' } } },
                preview: { glyph: 'above', verb: 'Move above Start a session', target: 'Start a session' },
            } }), execute: async () => { await receipt.promise; return { status: 'applied' }; } },
        });
        return <SessionSurfaceEntityFeedback kind="home-section" scope={SCOPE} address={null} testID="surface" />;
    }
    const screen = await renderScreen(<Surface />);
    const announcement = () => screen.findByTestId('surface-live-region')!.findAllByType(Text)
        .map(node => node.props.children).join('');
    let move: Promise<unknown> | undefined;
    try {
        await act(async () => { move = drag!.runtime.perform(drag!.sourceId, drag!.targetId); });
        expect(drag!.runtime.getSnapshot().phase).toBe('pending');
        expect(announcement()).not.toBe('');
        await act(async () => { receipt.resolve(); await move; });
        expect(drag!.runtime.getSnapshot().phase).toBe('settled');
        expect(announcement()).toBe('');
    } finally { receipt.resolve(); await move; await act(async () => { drag?.runtime.cancel('test-end'); }); }
});


it('forwards destination feedback keys for equivalent and different admitted positions', async () => {
    const { useSessionSurfaceEntityDrag } = await import('./SessionSurfaceEntityDrag');
    const drag = (await renderHook(() => useSessionSurfaceEntityDrag({
        scope: SCOPE, isCurrent: () => true, title: 'Capacity',
        getItem: () => ({ kind: 'home-section', scope: SCOPE, sectionId: 'capacity' }),
        getNativeBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
        pointerDestination: (_bounds, pointer) => ({ index: pointer.y < 80 ? 1 : 2 }),
        target: { acceptedKinds: ['home-section'],
            resolve: context => ({ status: 'allowed', effect: { actionId: 'home.hub.layout.update',
                input: context.destination ?? {}, preview: { verb: 'Move', target: 'Home' } } }),
            getDestinationKey: (_context, admission) => JSON.stringify(admission.effect.input),
            execute: async () => ({ status: 'applied' }),
        },
    }))).getCurrent();
    try {
        const carry = drag.runtime.begin(drag.sourceId);
        carry?.move({ x: 50, y: 25 });
        const key = drag.runtime.getSnapshot().destinationKey;
        expect(key).toBe(JSON.stringify({ index: 1 }));
        carry?.move({ x: 50, y: 60 });
        expect(drag.runtime.getSnapshot().destinationKey).toBe(key);
        carry?.move({ x: 50, y: 90 });
        expect(drag.runtime.getSnapshot().destinationKey).toBe(JSON.stringify({ index: 2 }));
    } finally { drag.runtime.cancel(); }
});
