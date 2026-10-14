import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import { useFullscreenDetailsRouteController } from './useFullscreenDetailsRouteController';
import type { UseFullscreenDetailsRouteControllerInput } from './useFullscreenDetailsRouteController';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ControllerHarness({
    onUnmount,
}: {
    onUnmount: () => void;
}) {
    useFullscreenDetailsRouteController({
        resetKey: 'scope-1',
        enabled: true,
        isFocused: true,
        hydrated: true,
        detailsIsOpen: true,
        hasDetails: true,
        onDismissRoute: () => {},
        onCloseDetails: () => {},
        onUnmount,
    });
    return null;
}

describe('useFullscreenDetailsRouteController', () => {
    it('dismisses a newly addressed route after reset, without dismissing an unfocused or retained route', async () => {
        const dismiss = vi.fn();
        const input: UseFullscreenDetailsRouteControllerInput = {
            resetKey: 'scope-1', enabled: true, isFocused: false, hydrated: true,
            detailsIsOpen: false, hasDetails: false, onCloseDetails: () => {}, onDismissRoute: dismiss,
        };
        function Controller({ value }: { value: UseFullscreenDetailsRouteControllerInput }) {
            useFullscreenDetailsRouteController(value);
            return null;
        }
        const screen = await renderScreen(<Controller value={input} />);
        expect(dismiss).not.toHaveBeenCalled();
        await screen.update(<Controller value={{ ...input, isFocused: true, keepRouteWhenEmpty: true }} />);
        expect(dismiss).not.toHaveBeenCalled();
        await screen.update(<Controller value={{ ...input, isFocused: true }} />);
        expect(dismiss).toHaveBeenCalledTimes(1);
        await screen.update(<Controller value={{ ...input, isFocused: true, detailsIsOpen: true }} />);
        await screen.update(<Controller value={{ ...input, isFocused: true }} />);
        expect(dismiss).toHaveBeenCalledTimes(1);
        await screen.update(<Controller value={{ ...input, resetKey: 'scope-2', isFocused: true }} />);
        expect(dismiss).toHaveBeenCalledTimes(2);
        standardCleanup();
    });
    it('dismisses once when an explicit close transitions the real pane state', async () => {
        const dismiss = vi.fn();
        function StatefulController() {
            const [open, setOpen] = React.useState(true);
            const { onRequestClose } = useFullscreenDetailsRouteController({
                resetKey: 'scope-1', enabled: true, isFocused: true, hydrated: true,
                detailsIsOpen: open, hasDetails: true,
                onCloseDetails: () => setOpen(false), onDismissRoute: dismiss,
            });
            return React.createElement('close', { onPress: onRequestClose, open });
        }
        const screen = await renderScreen(<StatefulController />);
        await act(async () => screen.findByType('close').props.onPress());
        expect(screen.findByType('close').props.open).toBe(false);
        expect(dismiss).toHaveBeenCalledTimes(1);
        standardCleanup();
    });

    it('does not run unmount cleanup during ordinary rerenders when callback identity changes', async () => {
        const firstUnmount = vi.fn();
        const secondUnmount = vi.fn();
        const screen = await renderScreen(<ControllerHarness onUnmount={firstUnmount} />);

        await screen.update(<ControllerHarness onUnmount={secondUnmount} />);

        expect(firstUnmount).not.toHaveBeenCalled();
        expect(secondUnmount).not.toHaveBeenCalled();

        standardCleanup();

        expect(firstUnmount).not.toHaveBeenCalled();
        expect(secondUnmount).toHaveBeenCalledTimes(1);
    });
});
