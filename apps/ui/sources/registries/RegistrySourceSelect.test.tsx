import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { HAPPIER_PICKS_SOURCE_ID } from '@happier-dev/protocol/registries';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createRegistrySourcesUiHome } = await import('@/dev/testkit/harness/registrySourcesUiHarness');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const { RegistrySourceSelect } = await import('./RegistrySourceSelect');
const { ToolbarSelect } = await import('@/components/ui/forms/ToolbarSelect');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

describe('RegistrySourceSelect through the Account source owner', () => {
    it('leads with available picks and opens Add and Manage with distinct intent without changing selection', async () => {
        const { sourceId } = await createRegistrySourcesUiHome('select-picks', { picks: true });
        const onChange = vi.fn();
        const onOpenRegistries = vi.fn();
        const screen = await renderScreen(<RegistrySourceSelect kind="skill" value="all" onChange={onChange}
            onOpenRegistries={onOpenRegistries} testID="registry" />);
        await waitForHomeGovernance(() => expect(screen.findByType(ToolbarSelect).props.items.map((item: { id: string }) => item.id))
            .toContain(HAPPIER_PICKS_SOURCE_ID));
        const select = screen.findByType(ToolbarSelect);
        expect(select.props.items.map((item: { id: string }) => item.id)).toEqual(['all', HAPPIER_PICKS_SOURCE_ID, 'builtin:skills-sh', sourceId]);
        await React.act(async () => { screen.findByType(DropdownMenu).props.onSelect('action:add'); });
        await React.act(async () => { screen.findByType(DropdownMenu).props.onSelect('action:manage'); });
        expect(onOpenRegistries.mock.calls).toEqual([['add'], ['manage']]);
        expect(onChange).not.toHaveBeenCalled();
    });
});
