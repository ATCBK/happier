import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    storage: async (original) => original(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

describe('NewSessionWizardAdaptiveSelection', () => {
    let restorePopoverGlobals: () => void;
    beforeEach(() => { restorePopoverGlobals = withPopoverWebGlobals(); });
    afterEach(() => restorePopoverGlobals());
    it('resolves explicit wizard presentation before auto presentation', async () => {
        const { resolveWizardAdaptivePresentation } = await import('./NewSessionWizardAdaptiveSelection');

        expect(resolveWizardAdaptivePresentation('dropdown', 'expanded')).toBe('compact');
        expect(resolveWizardAdaptivePresentation('list', 'compact')).toBe('expanded');
        expect(resolveWizardAdaptivePresentation('auto', 'compact')).toBe('compact');
        expect(resolveWizardAdaptivePresentation(undefined, 'expanded')).toBe('expanded');
    });

    it('draws the compact select as the wizard value row and opens its menu from it', async () => {
        const { NewSessionWizardDropdownSelectionItem } = await import('./NewSessionWizardAdaptiveSelection');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(<NewSessionWizardDropdownSelectionItem
            testID="trigger"
            title="Select Thing"
            subtitle="Current Thing"
            icon={null}
            items={[{ id: 'thing', title: 'Current Thing' }]}
            selectedId="thing"
            boundaryRef={{ current: null }}
            onSelect={() => {}}
        />);

        expect(screen.getTextContent()).toContain('Select Thing');
        expect(screen.findByType(DropdownMenu).props.open).toBe(false);
        await screen.pressByTestIdAsync('trigger');
        // The dropdown opens on the next frame, after the press that asked for it has finished.
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        expect(screen.findByType(DropdownMenu).props.open).toBe(true);
    });

    it('retires pending work when the mounted wizard popover closes', async () => {
        const { AgentInputContentPopover } = await import('@/components/sessions/agentInput/components/AgentInputContentPopover');
        const { NewSessionWizardPopoverItem } = await import('./NewSessionWizardAdaptiveSelection');
        const { OverlayPortalHost, OverlayPortalProvider } = await import('@/components/ui/popover/OverlayPortal');
        const retirePendingWork = vi.fn();
        const screen = await renderScreen(<NewSessionWizardPopoverItem
            testID="trigger"
            title="Run on"
            icon={null}
            boundaryRef={{ current: null }}
            popover={{
                renderContent: () => null,
                onRequestClose: retirePendingWork,
            }}
        />, { wrapper: ({ children }) => <OverlayPortalProvider>{children}<OverlayPortalHost /></OverlayPortalProvider> });

        await screen.pressByTestIdAsync('trigger');
        const popover = screen.findByType(AgentInputContentPopover);
        await act(async () => { popover.props.onRequestClose(); });

        expect(retirePendingWork).toHaveBeenCalledOnce();
        await screen.unmount();
    });
});
