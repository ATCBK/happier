import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { MultiPaneHost } from './MultiPaneHost';
import { renderScreen } from '@/dev/testkit';
import { useLayoutPresentationActive, usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (overlayDetails)', () => {
    it('renders a scrim for overlay details, exposes a resizer, and closes on scrim press', async () => {
        vi.useFakeTimers();
        const onCloseDetails = vi.fn();

        const screen = await renderScreen(<MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={<Details />}
                layout={{ main: 'docked', kind: 'twoPane', right: 'docked', details: 'overlay' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={onCloseDetails}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />);

        const overlay = screen.tree.findByProps({ testID: 'multi-pane-details-overlay' });
        expect(overlay).toBeTruthy();

        const overlayWrapper = overlay.parent;
        expect(readZIndex(overlayWrapper?.props?.style)).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('multi-pane-details-scrim');
        expect(onCloseDetails).toHaveBeenCalledTimes(0);
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(onCloseDetails).toHaveBeenCalledTimes(1);
    });
});

describe('MultiPaneHost (presentation under an overlay)', () => {
    it('keeps the docked panes presented while the details overlay is open; only the main column it covers stops taking input', async () => {
        const seen: Record<string, { presented: boolean; focusable: boolean }> = {};
        const Probe = (props: { name: string }) => {
            seen[props.name] = { presented: useLayoutPresentationActive(), focusable: usePluginSurfaceFocusEligibility() };
            return React.createElement(props.name);
        };
        const screen = await renderScreen(<MultiPaneHost
                main={<Probe name="main" />}
                rightPane={<Probe name="right" />}
                detailsPane={<Probe name="details" />}
                layout={{ main: 'docked', kind: 'twoPane', right: 'docked', details: 'overlay' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />);
        // The drawer is inset by the docked side column's width: it covers the main column only, so
        // the column beside it (Problems, References) stays live (T-INTEL H-T1).
        expect(seen).toEqual({
            main: { presented: true, focusable: false },
            right: { presented: true, focusable: true },
            details: { presented: true, focusable: true },
        });
        const rightBoundary = screen.tree.findByProps({ testID: 'multi-pane-right-docked' }).parent!;
        expect(rightBoundary.props.pointerEvents).not.toBe('none');
        expect(rightBoundary.props.inert).toBeUndefined();
        const mainUnderlay = screen.tree.findByProps({ testID: 'multi-pane-main-underlay' });
        expect(mainUnderlay.props.pointerEvents).toBe('none');
    });
});

function readZIndex(style: unknown): number {
    if (Array.isArray(style)) return Math.max(0, ...style.map(readZIndex));
    if (!style || typeof style !== 'object') return 0;
    const asAny = style as any;
    const value = asAny?.zIndex;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}

function Details() {
    return React.createElement('Details');
}
