import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Only the daemon RPC adapters and the modal host are boundaries here; the
// registry profile administration and the source registry owner stay real.
const mocks = vi.hoisted(() => ({
    profilesGet: vi.fn(),
    profilesMutate: vi.fn(),
    sourcesGet: vi.fn(),
    sourcesMutate: vi.fn(),
    show: vi.fn(),
    prompt: vi.fn(),
    alert: vi.fn(),
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    View: 'View',
    ScrollView: 'ScrollView',
    Text: 'Text',
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
    theme: { colors: { accent: { blue: 'blue' } } },
}));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/sync/ops/machineNpmRegistryProfiles', () => ({
    machineNpmRegistryProfilesGet: mocks.profilesGet,
    machineNpmRegistryProfilesMutate: mocks.profilesMutate,
}));
vi.mock('@/sync/ops/machineMarketplaceSources', () => ({
    machineMarketplaceSourceRegistryGet: mocks.sourcesGet,
    machineMarketplaceSourceRegistryMutate: mocks.sourcesMutate,
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { show: mocks.show, prompt: mocks.prompt, alert: mocks.alert },
}).module);
import { PluginRegistryProfileSelectionDialog } from './PluginRegistryProfileSelectionDialog';

const TEAM_SOURCE = {
    id: 'marketplace:team', title: 'Team catalog', sourceUrl: 'https://team.example.test/index.json',
    enabled: true, origin: 'user' as const, addedAtMs: 1, updatedAtMs: 1,
};
const OTHER_SOURCE = {
    id: 'marketplace:other', title: 'Other catalog', sourceUrl: 'https://other.example.test/index.json',
    enabled: true, origin: 'user' as const, addedAtMs: 1, updatedAtMs: 1,
};

function registry(registryProfileId: string | null) {
    return {
        t: 'happier_marketplace_source_registry_v1' as const,
        schemaVersion: 1 as const,
        sources: [{ ...TEAM_SOURCE, ...(registryProfileId ? { registryProfileId } : {}) }, OTHER_SOURCE],
    };
}

const executionTarget = {
    kind: 'resolved',
    target: { serverIdentityId: 'identity-a', machineId: 'machine-a' },
    serverId: 'server-a',
    profile: { id: 'server-a', name: 'Server A', serverUrl: 'https://server-a.example.test', serverIdentityId: 'identity-a', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
    machine: { id: 'machine-a', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
} as const;

async function flush(): Promise<void> {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderDialog() {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    let chrome: Readonly<{ footer?: React.ReactElement }> | null = null;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
        tree = create(
            <PluginRegistryProfileSelectionDialog
                requirement={{ registryOrigin: 'https://npm.acme.example', packageName: '@acme/private', registryProfileId: null }}
                pluginName="Private Plugin"
                sourceId="marketplace:team"
                target={{ machine: 'machine-a', server: 'Server A' }}
                daemonOperationsAvailable
                targetSelection={{
                    selectedTarget: executionTarget.target,
                    canExecute: true,
                    resolveExecutionTarget: () => executionTarget as never,
                }}
                sourceRegistry={{
                    scopeKey: 'identity-a:machine-a',
                    executionTarget: executionTarget as never,
                    resolveCurrentExecutionTarget: () => executionTarget as never,
                }}
                onResolve={onResolve}
                onClose={onClose}
                setChrome={(next: unknown) => { chrome = next as typeof chrome; }}
            />,
        );
    });
    await flush();
    await flush();
    return { tree, onResolve, onClose, footer: () => chrome?.footer ?? null };
}

describe('PluginRegistryProfileSelectionDialog', () => {
    beforeEach(() => {
        for (const mock of Object.values(mocks)) mock.mockReset();
        mocks.profilesGet.mockResolvedValue({
            status: 'success',
            snapshot: {
                protocolVersion: 1, revision: 2, pausedSources: [],
                profiles: [{
                    profileId: 'registry_acme', displayName: 'Acme', origin: 'https://npm.acme.example', scopes: ['@acme'],
                    useAsDefault: false, allowPrivateNetwork: false, hasCredentials: true,
                    authenticationState: 'authenticated', availability: 'available', lastSuccessfulCheckAtMs: 1, updatedAtMs: 1,
                }],
            },
        });
        mocks.sourcesGet.mockResolvedValue(registry(null));
        mocks.sourcesMutate.mockResolvedValue({ status: 'success', registry: registry('registry_acme') });
        mocks.show.mockReturnValue('npm-registry-profile-editor');
    });

    it('binds the listing source to a chosen profile through the source registry owner', async () => {
        const { tree } = await renderDialog();

        // Only the source the install resolves through is offered for binding.
        const menus = tree.root.findAllByType(DropdownMenu);
        expect(menus.map((node) => node.props.testID)).toEqual(['settings.plugins.registries.marketplaceBinding.marketplace:team']);
        expect(menus[0]!.props.selectedId).toBe('');

        await act(async () => { menus[0]!.props.onSelect('registry_acme'); });
        await flush();

        expect(mocks.sourcesMutate).toHaveBeenCalledWith('machine-a', {
            kind: 'setRegistryProfile', sourceId: 'marketplace:team', registryProfileId: 'registry_acme',
        }, { serverId: 'server-a' });
        // The binding shown is the owner's settled answer, not a local guess.
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.marketplaceBinding.marketplace:team' }).props.selectedId)
            .toBe('registry_acme');
    });

    it('starts a new profile from the registry the daemon named', async () => {
        const { tree } = await renderDialog();

        await act(async () => { await tree.root.findByProps({ testID: 'settings.plugins.registries.add' }).props.onPress(); });

        expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({
                mode: 'create',
                subject: {
                    displayName: 'npm.acme.example',
                    origin: 'https://npm.acme.example',
                    scopes: ['@acme'],
                    useAsDefault: false,
                    allowPrivateNetwork: false,
                },
            }),
        }));
    });

    it('resolves Continue and Cancel as the user answer', async () => {
        /** The footer is card chrome the modal host renders; its buttons are read from it directly. */
        const footerButton = (footer: React.ReactElement | null, testID: string) => (
            React.Children.toArray((footer?.props as Readonly<{ children?: React.ReactNode }>)?.children) as React.ReactElement<{
                testID?: string;
                onPress: () => void;
            }>[]
        ).find((child) => child.props.testID === testID)!;

        const continued = await renderDialog();
        act(() => { footerButton(continued.footer(), 'settings.plugins.registrySelection.continue').props.onPress(); });
        expect(continued.onResolve).toHaveBeenCalledWith(true);
        expect(continued.onClose).toHaveBeenCalled();

        const cancelled = await renderDialog();
        act(() => { footerButton(cancelled.footer(), 'settings.plugins.registrySelection.cancel').props.onPress(); });
        expect(cancelled.onResolve).toHaveBeenCalledWith(false);
    });
});
