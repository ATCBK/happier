import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACTIONS_SETTINGS_V1, setActionApprovalOverride, type ActionId } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import { applyActionSettingsTargetControlState, resolveActionSettingsTargetControlState } from './resolveActionSettingsControlState';
import { ActionSettingsTargetModeControl } from './ActionSettingsTargetModeControl';

installNavigationCommonModuleMocks();
afterEach(standardCleanup);

function ControlHarness(props: Readonly<{
    actionId: ActionId;
    targetId: 'agent' | 'contextual_ui';
    Control: typeof import('./ActionSettingsTargetModeControl').ActionSettingsTargetModeControl;
}>) {
    const [settings, setSettings] = React.useState(() => setActionApprovalOverride({
        settings: DEFAULT_ACTIONS_SETTINGS_V1,
        actionId: props.actionId,
        surface: props.targetId === 'agent' ? 'agent' : 'ui',
        approvalRequired: false,
    }));
    return <props.Control
        testIDPrefix="confirmation"
        accessibilityLabel="Action availability"
        controlState={resolveActionSettingsTargetControlState({ settings, actionId: props.actionId, targetId: props.targetId })}
        onChange={(value) => setSettings((current) => applyActionSettingsTargetControlState({ settings: current, actionId: props.actionId, targetId: props.targetId, value }))}
    />;
}

describe('ActionSettingsTargetModeControl', () => {
    it('offers only Off and Ask first for a mandatory Agent action and preserves both transitions', async () => {
        const screen = await renderScreen(<ControlHarness Control={ActionSettingsTargetModeControl} actionId="workflow.trigger.add" targetId="agent" />);
        expect(screen.findByTestId('confirmation:mode:allowed')).toBeNull();
        expect(screen.findByTestId('confirmation:mode:default')).toBeNull();
        expect(screen.findByTestId('confirmation:mode:ask_first')?.props.accessibilityState.checked).toBe(true);
        await screen.pressByTestIdAsync('confirmation:mode:off');
        expect(screen.findByTestId('confirmation:mode:off')?.props.accessibilityState.checked).toBe(true);
        await screen.pressByTestIdAsync('confirmation:mode:ask_first');
        expect(screen.findByTestId('confirmation:mode:ask_first')?.props.accessibilityState.checked).toBe(true);
    });

    it('keeps four choices and an effective waiver for an ordinary present-user Action', async () => {
        const screen = await renderScreen(<ControlHarness Control={ActionSettingsTargetModeControl} actionId="session.responsibility.set" targetId="contextual_ui" />);
        for (const choice of ['off', 'default', 'ask_first', 'allowed']) {
            expect(screen.findByTestId(`confirmation:mode:${choice}`)).not.toBeNull();
        }
        expect(screen.findByTestId('confirmation:mode:allowed')?.props.accessibilityState.checked).toBe(true);
        await screen.pressByTestIdAsync('confirmation:mode:ask_first');
        expect(screen.findByTestId('confirmation:mode:ask_first')?.props.accessibilityState.checked).toBe(true);
        await screen.pressByTestIdAsync('confirmation:mode:allowed');
        expect(screen.findByTestId('confirmation:mode:allowed')?.props.accessibilityState.checked).toBe(true);
    });

    it.each(['machines.resources.policy.set', 'machines.storage.trash.move'] as const)(
        'keeps the user waiver available for resource Action %s',
        async (actionId) => {
            const screen = await renderScreen(<ControlHarness Control={ActionSettingsTargetModeControl} actionId={actionId} targetId="agent" />);
            expect(screen.findByTestId('confirmation:mode:allowed')?.props.accessibilityState.checked).toBe(true);
            expect(screen.findByTestId('confirmation:mode:default')).not.toBeNull();
        },
    );
});
