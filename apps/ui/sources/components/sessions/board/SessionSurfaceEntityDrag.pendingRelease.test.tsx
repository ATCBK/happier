// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installEntityDragCancellation } from '@/components/ui/treeDragDrop/entityDragCancellation';
import { admitWidgetEntityMovement } from '@/sync/ops/actions/widgetEntityMovement';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(() => { standardCleanup(); });
// Heavy module graphs load while the file is collected, not inside a timed test.
const { useSessionSurfaceEntityDrag, SessionSurfaceEntityFeedback } = await import('./SessionSurfaceEntityDrag');
const { HubWidgetSection } = await import('@/components/hub/HubWidgetSection');
const { createNearViewportTracker } = await import('@/components/widgets/nearViewport');

const SCOPE = { serverId: 'home-1', accountId: 'account-1' };
const surface = { ...SCOPE, owner: { kind: 'home' as const } };

/** A Home widget card over Home's "new row" place whose admission read has not answered yet. */
async function mountPendingHome() {
    const move = { actionId: 'widgets.item.move' as const,
        input: { ref: { surface, instanceId: 'card' }, to: { surface, position: { groupId: null, anchorId: null, placement: 'after' } } },
        preview: { glyph: 'below' as const, verb: 'Move to a new row', target: 'Home' } };
    const binding = {
        scope: SCOPE, isCurrent: () => true, title: 'Capacity',
        getItem: () => ({ kind: 'home-section' as const, scope: SCOPE, sectionId: 'card' }),
        getNativeBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
        admitWidgetMovement: (effect: Parameters<typeof admitWidgetEntityMovement>[0]) => admitWidgetEntityMovement(effect, null),
        target: { acceptedKinds: ['home-section' as const], resolve: () => ({ status: 'allowed' as const, effect: move }),
            execute: async () => ({ status: 'applied' as const }) },
    };
    let drag: ReturnType<typeof useSessionSurfaceEntityDrag> | undefined;
    // The page head hosts the staged preview only; the released line belongs to the card.
    function Source() { drag = useSessionSurfaceEntityDrag(binding); return null; }
    function Home() {
        return <>
            <SessionSurfaceEntityFeedback kind="home-section" scope={SCOPE} address={null} testID="home-hub.widget-move" />
            <Source />
            <HubWidgetSection instance={{ v: 1 as const, id: 'card', definition: { kind: 'builtin' as const, id: 'usage_capacity' as const }, bindings: {} }}
                frameStyle="card" menu={null} entityDrag={binding} testID="home-hub.section.card"
                tracker={createNearViewportTracker({ quantum: 40, initialViewportHeight: 0 })} />
        </>;
    }
    const screen = await renderScreen(<Home />);
    const stop = installEntityDragCancellation(drag!.runtime, window);
    return { screen, drag: drag!, stop };
}

type Node = { children: readonly (Node | string)[] };
const wordsOf = (node: Node): string => node.children.map(child => typeof child === 'string' ? child : wordsOf(child)).join(' ');
/** The words the card keeps after the carry ended; the page head keeps none. */
const refusal = (screen: Awaited<ReturnType<typeof mountPendingHome>>['screen']) => {
    expect(screen.findByTestId('home-hub.widget-move-settled')).toBeNull();
    const line = screen.findByTestId('home-hub.section.card.drop-feedback-settled');
    return line ? wordsOf(line as unknown as Node) : null;
};

it('keeps the refusal under the released Home card, not at the page head, after a pointer release that arrives while the place is still being checked', async () => {
    const { screen, drag, stop } = await mountPendingHome();
    try {
        const carry = drag.runtime.begin(drag.sourceId, 'pointer')!;
        await act(async () => { carry.move({ x: 50, y: 50 }); });
        expect(drag.runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'widget_admission_pending' } });
        await act(async () => { await carry.release(); });
        expect(refusal(screen)).toContain('entityDragDrop.settled.pendingTitle');
    } finally { stop(); }
});

it('keeps the same refusal when the browser ends the drag over the still-checking place without delivering a drop', async () => {
    const { screen, drag, stop } = await mountPendingHome();
    const source = document.createElement('div');
    source.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
    document.body.append(source);
    try {
        // Web DOM boundary: on web the drag ref receives the host element React Native Web renders for a View.
        await act(async () => { drag.ref(source as unknown as Parameters<typeof drag.ref>[0]); });
        const dragEvent = (type: string) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: 50, clientY: 50 });
        await act(async () => { source.dispatchEvent(dragEvent('dragstart')); });
        expect(drag.runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'widget_admission_pending' } });
        // The browser accepts no drop on a refused place: the next and last event is the source's dragend.
        await act(async () => { source.dispatchEvent(dragEvent('dragend')); await Promise.resolve(); });
        expect(refusal(screen)).toContain('entityDragDrop.settled.pendingTitle');
    } finally { stop(); source.remove(); }
});
