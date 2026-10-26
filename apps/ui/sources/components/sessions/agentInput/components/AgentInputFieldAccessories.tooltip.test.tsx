import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { readHitFrameReach } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const { AgentInputFieldAccessories } = await import('./AgentInputFieldAccessories');
afterEach(standardCleanup);

describe('the prompt library button\'s tooltip', () => {
    it('honors resolved accessory order while keeping the same library interaction', async () => {
        const onOpenLibrary = vi.fn();
        const screen = await renderScreen(<AgentInputFieldAccessories
            showLibrary onOpenLibrary={onOpenLibrary} belowToggle={false}
            orderedIds={['dictate', 'promptLibrary']}
            accessory={React.createElement('Dictate', { testID: 'dictate' })}
        />);
        const controls = screen.findAll((node) => node.props.testID === 'dictate' || node.type === IconButton);
        expect(controls.map((node) => node.props.testID)).toEqual(['dictate', 'agent-input-prompt-library']);
        await screen.pressByTestIdAsync('agent-input-prompt-library');
        expect(onOpenLibrary).toHaveBeenCalledOnce();
    });

    it('steps aside while its picker is open and returns when it closes', async () => {
        const render = (libraryOpen: boolean) => <AgentInputFieldAccessories showLibrary libraryOpen={libraryOpen} onOpenLibrary={() => {}} belowToggle={false} />;
        const screen = await renderScreen(render(false));
        const hidden = () => screen.findAllByType(IconButton).find((button) => button.props.testID === 'agent-input-prompt-library')?.props.tooltipHidden === true;
        expect(hidden()).toBe(false);
        await screen.update(render(true));
        expect(hidden()).toBe(true);
        await screen.update(render(false));
        expect(hidden()).toBe(false);
    });

    // A new session's Look chip sits 9 px above the accessories and takes 4 px of that gap: they take the other 5.
    it('reaches up only the 5 px of the gap it does not share with the Look chip above', async () => {
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <AgentInputFieldAccessories showLibrary onOpenLibrary={() => {}} belowToggle={false} />
            </HappierUiPlatformProvider>,
        );
        const reach = readHitFrameReach(screen.findByTestId('agent-input-prompt-library')!);
        expect(reach?.top).toBe(5);
        expect(reach?.bottom).toBe(10);
        expect(reach?.left).toBe(0);
    });
});
