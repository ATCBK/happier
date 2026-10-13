import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from './promptRegistriesScreenTestHelpers';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@happier-dev/iroh-native', async original =>
    (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptRegistriesCommonModuleMocks({ storage: original => original() });
const { createPromptLibraryCatalogBoundary } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { createPromptMachineTransferFixture, createPromptRegistrySkillFixture, installPromptMachineSocketBoundary } =
    await import('@/dev/testkit/harness/promptMachineTransferBoundary');
installPromptMachineSocketBoundary();
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { PromptRegistriesScreen } = await import('./PromptRegistriesScreen');

describe('registry source catalog mutation through Actions', () => {
    it.each(['updated', 'conflict'] as const)('preserves neighbors and clears the source draft only after Account CAS acknowledgement: %s', async mutationOutcome => {
        const registry = createPromptRegistrySkillFixture({ sourceId: 'catalog-source', itemId: 'review', title: 'Review',
            files: [{ path: 'SKILL.md', content: '# Review' }] });
        const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2,
            sources: [{ id: 'catalog-source', title: 'Catalog source', format: 'git', kinds: ['skill'], enabled: true,
                url: 'https://catalog.test/skills.git', token: { secretRef: 'catalog-token' }, addedAt: 1 }],
            disabledSourceIds: BUILT_IN_REGISTRY_SOURCES_V1.map(source => source.id),
        } }], revision: 4, mutationOutcome });
        const fixture = await createPromptMachineTransferFixture({ serverUrl: `https://registry-row-${mutationOutcome}.test`,
            serverIdentityId: `srv_registry_row_${mutationOutcome}`, selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptRegistries,
            types: [], registryItem: registry.item, registryFiles: registry.files, handleHomeRequest: catalog.handle });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const screen = await renderScreen(<PromptRegistriesScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('promptRegistries.item.0')).not.toBeNull());
        await screen.pressByTestIdAsync('promptRegistries.addGitSource');
        await act(async () => {
            screen.changeTextByTestId('promptRegistries.sourceTitle', 'New source');
            screen.changeTextByTestId('promptRegistries.sourceUrl', 'https://new.test/skills.git');
        });
        const save = screen.findAll(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === 'common.save'
            && typeof node.props.onPress === 'function')[0];
        if (!save) throw new Error('Missing source save control');
        await act(async () => { await save.props.onPress(); });
        if (mutationOutcome === 'updated') {
            await vi.waitFor(() => expect(catalog.read('registry-sources').value).toMatchObject({ v: 2, sources: [
                expect.objectContaining({ id: 'catalog-source', token: { secretRef: 'catalog-token' } }),
                expect.objectContaining({ title: 'New source', format: 'git', kinds: ['skill'], url: 'https://new.test/skills.git' }),
            ] }));
            expect(screen.findByTestId('promptRegistries.sourceTitle')).toBeNull();
        } else expect(screen.findByTestId('promptRegistries.sourceTitle')?.props.value).toBe('New source');
        expect(catalog.requests[0]).toMatchObject({ key: 'registry-sources', expectedRevision: 4 });
        expect(fixture.homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
    });
});
