/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

class GlobalAppFailureProbe extends React.Component<React.PropsWithChildren, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    override render() {
        return this.state.failed
            ? React.createElement('View', { testID: 'global-app-failure' })
            : this.props.children;
    }
}

afterEach(() => {
    vi.doUnmock('@/components/ui/overlays/AnchoredTooltip');
    vi.restoreAllMocks();
});

describe('tooltip chunk recovery', () => {
    it.each(['action', 'help'] as const)('keeps the %s surface usable after a failed chunk and retries on the next interaction', async (kind) => {
        vi.resetModules();
        const failure = new TypeError('Failed to fetch');
        // The lazy module transport is the failing system boundary; interaction owners stay real.
        vi.doMock('@/components/ui/overlays/AnchoredTooltip', () => { throw failure; });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { IconButton } = await import('../buttons/IconButton');
        const { Tooltip } = await import('./Tooltip');
        let actions = 0;
        const screen = await renderScreen(
            <GlobalAppFailureProbe>
                <IconButton testID="usable-action" icon={<React.Fragment />} accessibilityLabel="Next file" onPress={() => { actions += 1; }} />
                {kind === 'action'
                    ? <IconButton testID="tooltip-trigger" icon={<React.Fragment />} accessibilityLabel="Next file" tooltip="Next file" onPress={() => { actions += 1; }} />
                    : <Tooltip testID="tooltip-trigger" label="Large diff help"><React.Fragment /></Tooltip>}
            </GlobalAppFailureProbe>,
        );
        await act(async () => { screen.findHostByTestId('tooltip-trigger')?.props.onHoverIn?.(); });
        await vi.waitFor(() => {
            expect(warn.mock.calls.length + screen.findAllHostsByTestId('global-app-failure').length).toBeGreaterThan(0);
        });
        expect(screen.findAllHostsByTestId('global-app-failure')).toHaveLength(0);
        expect(warn.mock.calls.some((args) => args.some((value) => value === failure || (value instanceof Error && 'cause' in value && value.cause === failure)))).toBe(true);
        expect(screen.findAllHostsByTestId('tooltip-trigger-tooltip')).toHaveLength(0);
        await act(async () => { screen.findHostByTestId('usable-action')?.props.onPress?.(); });
        expect(actions).toBe(1);

        // A later successful chunk supplies content; portal geometry is covered by the DOM suite.
        vi.doMock('@/components/ui/overlays/AnchoredTooltip', () => ({
            default: (props: { testID?: string; label: string }) => React.createElement('View', { testID: props.testID }, props.label),
        }));
        if (kind === 'action') {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            await act(async () => { screen.findHostByTestId('tooltip-trigger')?.props.onFocus?.({
                target: { matches: (selector: string) => selector === ':focus-visible' },
            }); });
        } else {
            await act(async () => { screen.findHostByTestId('tooltip-trigger')?.props.onHoverOut?.(); });
            await act(async () => { screen.findHostByTestId('tooltip-trigger')?.props.onHoverIn?.(); });
        }
        await vi.waitFor(() => expect(screen.findAllHostsByTestId('tooltip-trigger-tooltip')).toHaveLength(1));
        expect(screen.findAllHostsByTestId('global-app-failure')).toHaveLength(0);
        await act(async () => { screen.findHostByTestId('usable-action')?.props.onPress?.(); });
        expect(actions).toBe(2);
    });
});
