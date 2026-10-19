import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { selectBrowserAgentPoint, selectBrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import { dispatchBrowserControlCommand } from '@/sync/domains/browser/control/commands';
import { applyBrowserControlEvent, createBrowserControlState } from '@/sync/domains/browser/control/reducer';

import { BrowserAgentCursor } from './BrowserAgentCursor';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('BrowserAgentCursor', () => {
    it('rings the target inside the drawn page, not the whole letterboxed surface', async () => {
        const target = { x: 0.5, y: 0.25, width: 0.2, height: 0.1 };
        // A 1280 × 800 page fitted into a 600 × 700 surface is drawn 600 × 375, 162.5 px from the top.
        const pageRect = { x: 0, y: 162.5, width: 600, height: 375 };
        const element = <BrowserAgentCursor testID="c" target={target} pageRect={pageRect} />;
        const screen = await renderScreen(element);
        const layer = screen.findByTestId('c');
        await act(async () => {
            layer?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 700 } } });
        });
        // The Reanimated test double evaluates animated styles during render: the placement written
        // by the effect shows on the next render of the same props.
        await screen.update(React.cloneElement(element));
        const ring = flatten(screen.findHostByTestId('c-ring')?.props.style);
        // The ring sits RING_OUTSET (3 px) outside the element: top = 162.5 + (0.25 - 0.05) × 375 - 3.
        expect(ring.top).toBeCloseTo(234.5);
        expect(ring.left).toBeCloseTo(237);
        expect(ring.height).toBeCloseTo(43.5);
    });

    describe('an action whose target and end are applied in one burst', () => {
        const identity = { browserSessionId: 'browser_1', viewId: 'view_1' };
        const notes = { x: 0.5, y: 0.5, width: 0.2, height: 0.1 };
        const controllerChanged = (eventId: string, state: Record<string, unknown>) => ({
            kind: 'controllerChanged' as const, eventId, ...identity, occurredAt: 1,
            state: { ...identity, controlEpoch: 0, ...state },
        }) as Parameters<typeof applyBrowserControlEvent>[1];

        async function renderBurst(withPoint: boolean) {
            const opened = dispatchBrowserControlCommand(createBrowserControlState(), {
                kind: 'openView', commandId: 'open', ...identity,
                target: { kind: 'streamedBrowser', targetId: 'stream_1', streamId: 'stream_1' },
                platform: 'web', currentUrl: 'https://example.test/', focus: true,
            });
            let apply: (events: readonly Parameters<typeof applyBrowserControlEvent>[1][]) => void = () => undefined;
            let rerender: () => void = () => undefined;
            function Probe() {
                const [state, setState] = React.useState(opened.state);
                const [, setTick] = React.useState(0);
                rerender = () => setTick(tick => tick + 1);
                apply = (events) => setState(previous => events.reduce(applyBrowserControlEvent, previous));
                const view = state.viewsById.view_1!;
                const presence = selectBrowserCopresence({ view: identity, snapshot: null, controllerState: view.automationController });
                return <BrowserAgentCursor testID="c"
                    target={presence.kind === 'agent' ? presence.target : null}
                    point={withPoint ? selectBrowserAgentPoint({ lastPoint: view.agentPoint, presence }) : null}
                    pageRect={{ x: 0, y: 0, width: 600, height: 400 }} />;
            }
            const screen = await renderScreen(<Probe />);
            await act(async () => {
                screen.findByTestId('c')?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 400 } } });
            });
            await act(async () => {
                // What the relay does for a quick click: the target, then the terminal state, in one batch.
                apply([
                    controllerChanged('target', { controller: 'agent', activeAutomationRequestId: 'req_1', activeActionKind: 'click', activeTarget: notes }),
                    controllerChanged('end', { controller: 'none' }),
                ]);
            });
            // The Reanimated test double evaluates animated styles during render: the placement written
            // by the effect shows on the next render.
            await act(async () => { rerender(); });
            return screen;
        }

        it('mounts the ring and the pointer where the agent clicked', async () => {
            const screen = await renderBurst(true);
            expect(screen.findHostByTestId('c-ring')).toBeTruthy();
            expect(screen.findHostByTestId('c-pointer')).toBeTruthy();
            // Placed at the click, not at the origin.
            expect(flatten(screen.findHostByTestId('c-ring')?.props.style).left).toBeCloseTo(600 * 0.4 - 3);
        });

        it('shows nothing from the live target alone, which is the failure the point removes', async () => {
            const screen = await renderBurst(false);
            expect(screen.findHostByTestId('c-pointer')).toBeFalsy();
        });
    });
});
