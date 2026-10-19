import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

const routerMock = vi.hoisted(() => ({ current: null as ReturnType<typeof createExpoRouterMock> | null }));

installNewSessionComponentsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock: create } = await import('@/dev/testkit/mocks/router');
        routerMock.current = create({ navigation: null });
        return routerMock.current.module;
    },
});

describe('NewSessionWizardWebDismissal', () => {
    it('closes the wizard from its own close control and from Escape, and lets an open picker take Escape first', async () => {
        const { NewSessionWizardWebDismissal } = await import('./NewSessionWizardWebDismissal');
        const { ESCAPE_LAYER_PRIORITIES, dispatchEscapeToLayerStack, useEscapeLayer, EscapeLayerProvider } = await import('@/keyboard/escape');
        const { router } = routerMock.current!.module;
        const back = routerMock.current!.spies.back;

        function Picker(): React.ReactElement {
            const layer = useEscapeLayer({ enabled: true, priority: ESCAPE_LAYER_PRIORITIES.popover, onEscape: () => true });
            return <EscapeLayerProvider layer={layer}>{React.createElement('Picker')}</EscapeLayerProvider>;
        }
        const screen = await renderScreen(<NewSessionWizardWebDismissal>{React.createElement('Form')}</NewSessionWizardWebDismissal>);
        expect(router).toBeTruthy();

        await screen.pressByTestIdAsync('new-session-cancel');
        expect(back).toHaveBeenCalledTimes(1);

        await act(async () => { expect(dispatchEscapeToLayerStack({ key: 'Escape' })).toBe(true); });
        expect(back).toHaveBeenCalledTimes(2);

        // A picker opened inside the wizard is a visual child: it consumes the press, the wizard stays.
        const withPicker = await renderScreen(
            <NewSessionWizardWebDismissal><Picker /></NewSessionWizardWebDismissal>,
        );
        await act(async () => { expect(dispatchEscapeToLayerStack({ key: 'Escape' })).toBe(true); });
        expect(back).toHaveBeenCalledTimes(2);
        withPicker.unmount?.();
    });
});
