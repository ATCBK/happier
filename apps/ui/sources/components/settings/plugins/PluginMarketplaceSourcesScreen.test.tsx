import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceSourceRegistryV1 } from '@happier-dev/protocol';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { t } from '@/text';

const mocks = vi.hoisted(() => ({
    prompt: vi.fn(),
    show: vi.fn(),
    confirm: vi.fn(),
    alertAsync: vi.fn(),
    upsertMarketplaceSource: vi.fn(),
    setMarketplaceSourceEnabled: vi.fn(),
    removeMarketplaceSource: vi.fn(),
    setMarketplaceSourceProfile: vi.fn(),
    refreshMarketplaceSourceRegistry: vi.fn(),
    registry: null as MarketplaceSourceRegistryV1 | null,
    registryLoading: false,
    registryLoadError: false,
    registryMutationInFlight: false,
    registryMutationOutcomeUnknown: false,
}));

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ View: 'View' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
    theme: { colors: { accent: { indigo: 'indigo', green: 'green' } } },
}));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { prompt: mocks.prompt, show: mocks.show, confirm: mocks.confirm, alertAsync: mocks.alertAsync },
}).module);
// The composed settings state hook pulls in the whole daemon administration
// environment (transport, capabilities, projections) behind its facade. This
// focused lane tests this screen's presentation and identity pass-through
// around that facade, so the facade is replaced whole here while every real
// boundary below it keeps its canonical testkit mock.
vi.mock('./model/usePluginSettingsScreenState', () => ({
    usePluginSettingsScreenState: () => ({
        daemonOperationsAvailable: true,
        daemonAdministrationAvailable: true,
        administrationTargetSelection: {
            selectedTarget: null,
            canExecute: false,
            resolveExecutionTarget: () => null,
        },
        marketplaceSourceRegistry: mocks.registry,
        marketplaceSourceRegistryLoading: mocks.registryLoading,
        marketplaceSourceRegistryLoadError: mocks.registryLoadError,
        marketplaceSourceRegistryMutationInFlight: mocks.registryMutationInFlight,
        marketplaceSourceRegistryMutationOutcomeUnknown: mocks.registryMutationOutcomeUnknown,
        refreshMarketplaceSourceRegistry: mocks.refreshMarketplaceSourceRegistry,
        upsertMarketplaceSource: mocks.upsertMarketplaceSource,
        setMarketplaceSourceEnabled: mocks.setMarketplaceSourceEnabled,
        removeMarketplaceSource: mocks.removeMarketplaceSource,
        setMarketplaceSourceProfile: mocks.setMarketplaceSourceProfile,
    }),
}));
vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', async () => ({
    MachineAdministrationTargetSelector: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('MachineAdministrationTargetSelector'),
}));
vi.mock('./NpmRegistryProfilesSection', async () => ({
    NpmRegistryProfilesSection: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('NpmRegistryProfilesSection'),
}));
import { PluginMarketplaceSourcesScreen } from './PluginMarketplaceSourcesScreen';

/** The section's "Add source" action: the button owner, which carries its busy and disabled state. */
function findAddSourceAction(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    return screen.findAll((node) => node.props?.testID === 'settings.plugins.sources.add' && 'loading' in node.props)[0] ?? null;
}

function findSourceRow(screen: Awaited<ReturnType<typeof renderSettingsView>>, testID: string) {
    return screen.findAll((node) => node.props.testID === testID && typeof node.props.title === 'string')[0] ?? null;
}

async function editSourceField(screen: Awaited<ReturnType<typeof renderSettingsView>>, name: string, value: string) {
    const field = screen.findAll((node) => node.props.testID === `settings.plugins.sources.draft.${name}` && typeof node.props.onChangeText === 'function')[0];
    expect(field).toBeDefined();
    await act(async () => { field.props.onChangeText(value); });
}

async function submitSource(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    await act(async () => { screen.pressRow('settings.plugins.sources.draft.save'); await flushHookEffects(); });
}

function createRegistry(): MarketplaceSourceRegistryV1 {
    return {
        t: 'happier_marketplace_source_registry_v1',
        schemaVersion: 1,
        sources: [
            {
                id: 'marketplace:curated',
                title: 'Curated',
                sourceUrl: 'https://curated.example.test/index.json',
                enabled: true,
                origin: 'curated',
                addedAtMs: 1,
                updatedAtMs: 1,
            },
            {
                id: 'marketplace:user',
                title: 'My source',
                sourceUrl: 'https://mine.example.test/index.json',
                enabled: true,
                origin: 'user',
                addedAtMs: 2,
                updatedAtMs: 2,
                registryProfileId: 'registry_one',
            },
        ],
    };
}

describe('PluginMarketplaceSourcesScreen', () => {
    beforeEach(() => {
        mocks.prompt.mockReset();
        mocks.show.mockReset();
        mocks.show.mockReturnValue('source-edit-form');
        mocks.confirm.mockReset();
        mocks.alertAsync.mockReset();
        mocks.upsertMarketplaceSource.mockReset();
        mocks.setMarketplaceSourceEnabled.mockReset();
        mocks.removeMarketplaceSource.mockReset();
        mocks.setMarketplaceSourceProfile.mockReset();
        mocks.upsertMarketplaceSource.mockResolvedValue({ status: 'success' });
        mocks.setMarketplaceSourceEnabled.mockResolvedValue({ status: 'success' });
        mocks.removeMarketplaceSource.mockResolvedValue({ status: 'success' });
        mocks.setMarketplaceSourceProfile.mockResolvedValue({ status: 'success' });
        mocks.refreshMarketplaceSourceRegistry.mockReset();
        mocks.registry = createRegistry();
        mocks.registryLoading = false;
        mocks.registryLoadError = false;
        mocks.registryMutationInFlight = false;
        mocks.registryMutationOutcomeUnknown = false;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('edits a user source by replacing the same source identity when its URL changes', async () => {
        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            screen.pressRow('settings.plugins.sources.source.marketplace:user');
            await flushHookEffects();
        });
        await editSourceField(screen, 'sourceUrl', 'https://renamed.example.test/index.json');
        await editSourceField(screen, 'title', 'Renamed source');
        await submitSource(screen);

        expect(mocks.upsertMarketplaceSource).toHaveBeenCalledTimes(1);
        expect(mocks.upsertMarketplaceSource).toHaveBeenCalledWith({
            sourceUrl: 'https://renamed.example.test/index.json',
            title: 'Renamed source',
            description: null,
            origin: 'user',
            enabled: true,
            registryProfileId: 'registry_one',
            sourceId: 'marketplace:user',
        });
        expect(mocks.alertAsync).not.toHaveBeenCalled();
    });

    it('adds a source from its URL and lets the daemon derive its display name', async () => {
        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            screen.pressRow('settings.plugins.sources.add');
            await flushHookEffects();
        });

        expect(mocks.upsertMarketplaceSource).not.toHaveBeenCalled();
        await editSourceField(screen, 'sourceUrl', 'https://added.example.test/index.json');
        await submitSource(screen);

        expect(mocks.upsertMarketplaceSource).toHaveBeenCalledTimes(1);
        expect(mocks.upsertMarketplaceSource).toHaveBeenCalledWith({
            sourceUrl: 'https://added.example.test/index.json',
            origin: 'user',
            enabled: true,
        });
        expect(mocks.prompt).not.toHaveBeenCalled();
    });

    it('abandons the new source when its inline draft is cancelled', async () => {

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            screen.pressRow('settings.plugins.sources.add');
            await flushHookEffects();
        });
        await act(async () => { screen.pressRow('settings.plugins.sources.draft.cancel'); });

        expect(mocks.upsertMarketplaceSource).not.toHaveBeenCalled();
        expect(mocks.alertAsync).not.toHaveBeenCalled();
        expect(findAddSourceAction(screen)?.props.loading).toBe(false);
    });

    it('abandons the complete source draft when its form is cancelled', async () => {
        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            screen.pressRow('settings.plugins.sources.source.marketplace:user');
            await flushHookEffects();
        });
        await editSourceField(screen, 'title', 'Unsaved name');
        await act(async () => { screen.pressRow('settings.plugins.sources.draft.cancel'); });

        expect(mocks.upsertMarketplaceSource).not.toHaveBeenCalled();
        expect(mocks.alertAsync).not.toHaveBeenCalled();
    });

    it('preserves all source fields for correction after an edit is rejected', async () => {
        mocks.upsertMarketplaceSource.mockResolvedValueOnce({ status: 'unavailable' });
        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            screen.pressRow('settings.plugins.sources.source.marketplace:user');
            await flushHookEffects();
        });
        const draft = { sourceUrl: 'https://new.example.test/index.json', title: 'New name', description: 'Keep this description' };
        for (const [name, value] of Object.entries(draft)) await editSourceField(screen, name, value);
        await submitSource(screen);
        const descriptionField = screen.findAll((node) => node.props.testID === 'settings.plugins.sources.draft.description' && typeof node.props.onChangeText === 'function')[0];
        expect(descriptionField?.props.value).toBe(draft.description);
        await editSourceField(screen, 'title', 'Corrected name');
        await submitSource(screen);
        expect(mocks.upsertMarketplaceSource).toHaveBeenLastCalledWith(expect.objectContaining({
            ...draft, title: 'Corrected name', sourceId: 'marketplace:user',
        }));
    });

    it('presents an error and releases the busy state when adding a source fails', async () => {
        mocks.upsertMarketplaceSource.mockRejectedValueOnce(new Error('machine unreachable'));

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            screen.pressRow('settings.plugins.sources.add');
            await flushHookEffects();
        });

        await editSourceField(screen, 'sourceUrl', 'https://added.example.test/index.json');
        await submitSource(screen);

        expect(mocks.upsertMarketplaceSource).toHaveBeenCalledTimes(1);
        expect(mocks.alertAsync).toHaveBeenCalledTimes(1);
        expect(mocks.alertAsync).toHaveBeenCalledWith(
            t('common.error'),
            t('settingsPlugins.sourceAdministration.operationFailed'),
        );
        expect(findAddSourceAction(screen)?.props.loading).toBe(false);
        expect(screen.findAll((node) => node.props.testID === 'settings.plugins.sources.draft.sourceUrl' && typeof node.props.onChangeText === 'function')[0]?.props.value)
            .toBe('https://added.example.test/index.json');
    });

    it('presents an error when toggling a source fails', async () => {
        mocks.setMarketplaceSourceEnabled.mockRejectedValueOnce(new Error('request timed out'));

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        const sourceRow = findSourceRow(screen, 'settings.plugins.sources.source.marketplace:user');
        await act(async () => {
            sourceRow?.props.rightElement.props.onValueChange(false);
            await flushHookEffects();
        });

        expect(mocks.setMarketplaceSourceEnabled).toHaveBeenCalledWith('marketplace:user', false);
        expect(mocks.alertAsync).toHaveBeenCalledTimes(1);
        expect(mocks.alertAsync).toHaveBeenCalledWith(
            t('common.error'),
            t('settingsPlugins.sourceAdministration.operationFailed'),
        );
        expect(findSourceRow(screen, 'settings.plugins.sources.source.marketplace:user')?.props.loading).toBe(false);
        expect(findSourceRow(screen, 'settings.plugins.sources.source.marketplace:user')?.props.disabled).toBe(false);
    });

    it('presents an issued mutation with an unknown outcome distinctly from a definite failure', async () => {
        mocks.setMarketplaceSourceEnabled.mockResolvedValueOnce({ status: 'outcomeUnknown' });

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        const sourceRow = findSourceRow(screen, 'settings.plugins.sources.source.marketplace:user');
        await act(async () => {
            sourceRow?.props.rightElement.props.onValueChange(false);
            await flushHookEffects();
        });

        expect(mocks.alertAsync).toHaveBeenCalledWith(
            t('settingsPlugins.sourceAdministration.operationOutcomeUnknownTitle'),
            t('settingsPlugins.sourceAdministration.operationOutcomeUnknownBody'),
        );
        expect(mocks.alertAsync).not.toHaveBeenCalledWith(
            t('common.error'),
            t('settingsPlugins.sourceAdministration.operationFailed'),
        );
    });

    it('presents a definite daemon validation rejection as an ordinary operation failure', async () => {
        mocks.setMarketplaceSourceEnabled.mockResolvedValueOnce({ status: 'unavailable' });

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        const sourceRow = findSourceRow(screen, 'settings.plugins.sources.source.marketplace:user');
        await act(async () => {
            sourceRow?.props.rightElement.props.onValueChange(false);
            await flushHookEffects();
        });

        expect(mocks.alertAsync).toHaveBeenCalledWith(
            t('common.error'),
            t('settingsPlugins.sourceAdministration.operationFailed'),
        );
        expect(mocks.alertAsync).not.toHaveBeenCalledWith(
            t('settingsPlugins.sourceAdministration.operationOutcomeUnknownTitle'),
            t('settingsPlugins.sourceAdministration.operationOutcomeUnknownBody'),
        );
    });

    it('exposes the enable switch for a curated source while keeping edit and removal user-only', async () => {
        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));

        const curatedRow = findSourceRow(screen, 'settings.plugins.sources.source.marketplace:curated');
        const curatedSwitch = curatedRow?.props.rightElement ?? null;
        if (!curatedSwitch) throw new Error('Expected the curated source row to expose its enable switch');
        expect(curatedSwitch.props.testID).toBe('settings.plugins.sources.enabled.marketplace:curated');
        expect(curatedSwitch.props.value).toBe(true);
        expect(curatedRow?.props.onPress).toBeUndefined();
        expect(screen.findRow('settings.plugins.sources.remove.marketplace:curated')).toBeNull();

        await act(async () => {
            curatedSwitch.props.onValueChange(false);
            await flushHookEffects();
        });

        expect(mocks.setMarketplaceSourceEnabled).toHaveBeenCalledTimes(1);
        expect(mocks.setMarketplaceSourceEnabled).toHaveBeenCalledWith('marketplace:curated', false);
        expect(mocks.alertAsync).not.toHaveBeenCalled();
    });

    it('labels each source toggle truthfully for its enabled or disabled state', async () => {
        mocks.registry = {
            ...createRegistry(),
            sources: createRegistry().sources.map((source) => (
                source.id === 'marketplace:user' ? { ...source, enabled: false } : source
            )),
        };

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));

        const enabledSwitch = findSourceRow(screen, 'settings.plugins.sources.source.marketplace:curated')?.props.rightElement;
        expect(enabledSwitch?.props.accessibilityLabel)
            .toBe(`Curated: ${t('settingsPlugins.sourceAdministration.enabled')}`);
        expect(enabledSwitch?.props.accessibilityState).toEqual({ checked: true, disabled: false });

        const disabledSwitch = findSourceRow(screen, 'settings.plugins.sources.source.marketplace:user')?.props.rightElement;
        expect(disabledSwitch?.props.accessibilityLabel)
            .toBe(`My source: ${t('settingsPlugins.sourceAdministration.disabled')}`);
        expect(disabledSwitch?.props.accessibilityState).toEqual({ checked: false, disabled: false });
    });

    it('confirms before removing, skips the removal on cancel, and presents an error when the removal fails', async () => {
        mocks.confirm.mockResolvedValueOnce(false);
        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));

        await act(async () => {
            screen.pressRow('settings.plugins.sources.remove.marketplace:user');
            await flushHookEffects();
        });
        expect(mocks.removeMarketplaceSource).not.toHaveBeenCalled();
        expect(mocks.alertAsync).not.toHaveBeenCalled();

        mocks.confirm.mockResolvedValueOnce(true);
        mocks.removeMarketplaceSource.mockRejectedValueOnce(new Error('machine unreachable'));
        await act(async () => {
            screen.pressRow('settings.plugins.sources.remove.marketplace:user');
            await flushHookEffects();
        });

        expect(mocks.confirm).toHaveBeenCalledTimes(2);
        expect(mocks.removeMarketplaceSource).toHaveBeenCalledTimes(1);
        expect(mocks.removeMarketplaceSource).toHaveBeenCalledWith('marketplace:user');
        expect(mocks.alertAsync).toHaveBeenCalledTimes(1);
        expect(mocks.alertAsync).toHaveBeenCalledWith(
            t('common.error'),
            t('settingsPlugins.sourceAdministration.operationFailed'),
        );
        expect(findSourceRow(screen, 'settings.plugins.sources.remove.marketplace:user')?.props.disabled).toBe(false);
    });

    it('names each repeated remove action with the source it removes', async () => {
        mocks.registry = {
            ...createRegistry(),
            sources: [
                ...createRegistry().sources,
                {
                    id: 'marketplace:user-two',
                    title: 'Team source',
                    sourceUrl: 'https://team.example.test/index.json',
                    enabled: true,
                    origin: 'user',
                    addedAtMs: 3,
                    updatedAtMs: 3,
                },
            ],
        };

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));

        expect(screen.findRow('settings.plugins.sources.remove.marketplace:user')?.props.accessibilityLabel)
            .toBe(buildActionRowAccessibilityLabel([
                t('settingsPlugins.sourceAdministration.remove'),
                'My source',
            ]));
        expect(screen.findRow('settings.plugins.sources.remove.marketplace:user-two')?.props.accessibilityLabel)
            .toBe(buildActionRowAccessibilityLabel([
                t('settingsPlugins.sourceAdministration.remove'),
                'Team source',
            ]));
    });

    it('shows loading without an empty answer while the first registry load is in flight', async () => {
        mocks.registry = null;
        mocks.registryLoading = true;

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));

        expect(screen.findRow('settings.plugins.sources.loading')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.empty')).toBeNull();
        expect(screen.findRow('settings.plugins.sources.retry')).toBeNull();
        // No authoritative registry exists yet, so adding a source stays unavailable.
        expect(findAddSourceAction(screen)?.props.disabled).toBe(true);
    });

    it('retains last-known source rows and indicates refresh while re-reading the registry', async () => {
        mocks.registryLoading = true;

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));

        expect(screen.findRow('settings.plugins.sources.source.marketplace:curated')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.source.marketplace:user')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.loading')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.empty')).toBeNull();
        // The retained registry remains authoritative, so Add stays available.
        expect(findAddSourceAction(screen)?.props.disabled).toBe(false);
    });

    it('presents the load error and retry without an empty answer when the first load fails', async () => {
        mocks.registry = null;
        mocks.registryLoadError = true;

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            screen.pressRow('settings.plugins.sources.retry');
            await flushHookEffects();
        });

        expect(mocks.refreshMarketplaceSourceRegistry).toHaveBeenCalledTimes(1);
        expect(screen.findRow('settings.plugins.sources.empty')).toBeNull();
        expect(screen.findRow('settings.plugins.sources.loading')).toBeNull();
    });

    it('retains last-known source rows beside the error and retry when a refresh fails', async () => {
        mocks.registryLoadError = true;

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));

        expect(screen.findRow('settings.plugins.sources.source.marketplace:curated')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.source.marketplace:user')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.retry')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.empty')).toBeNull();
    });

    it('keeps an unknown mutation outcome visible until the user refreshes daemon truth', async () => {
        mocks.registryMutationOutcomeUnknown = true;

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            screen.pressRow('settings.plugins.sources.outcomeUnknown');
            await flushHookEffects();
        });

        expect(mocks.refreshMarketplaceSourceRegistry).toHaveBeenCalledTimes(1);
        expect(findSourceRow(screen, 'settings.plugins.sources.outcomeUnknown')?.props.subtitle)
            .toBe(t('settingsPlugins.sourceAdministration.operationOutcomeUnknownBody'));
    });

    it('shows the empty answer only for a settled, authoritative, empty registry', async () => {
        mocks.registry = { ...createRegistry(), sources: [] };

        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSourcesScreen));

        expect(screen.findRow('settings.plugins.sources.empty')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.loading')).toBeNull();
        expect(screen.findRow('settings.plugins.sources.retry')).toBeNull();
    });
});
