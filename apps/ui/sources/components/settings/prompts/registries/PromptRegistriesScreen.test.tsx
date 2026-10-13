import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks, promptRegistriesRouterPushSpy } from './promptRegistriesScreenTestHelpers';

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

describe('PromptRegistriesScreen through registry Actions', () => {
    it('browses the Account source, submits search on intent and opens the addressed item', async () => {
        const registry = createPromptRegistrySkillFixture({ sourceId: 'catalog-source', itemId: 'review', title: 'Reviewer',
            files: [{ path: 'SKILL.md', content: '# Review' }] });
        const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2,
            sources: [{ id: registry.item.summary.sourceId, title: 'Private skills', format: 'git', kinds: ['skill'],
                url: 'https://catalog.test/skills.git', enabled: true, addedAt: 1, token: { secretRef: 'registry-token' } }],
            disabledSourceIds: BUILT_IN_REGISTRY_SOURCES_V1.map(source => source.id),
        } }], revision: 4 });
        const fixture = await createPromptMachineTransferFixture({ serverUrl: 'https://registry-browse.test',
            serverIdentityId: 'srv_registry_browse', selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptRegistries,
            types: [], registryItem: registry.item, registryFiles: registry.files, handleHomeRequest: catalog.handle });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        promptRegistriesRouterPushSpy.mockClear();
        const screen = await renderScreen(<PromptRegistriesScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('promptRegistries.item.0')).not.toBeNull());
        await screen.pressByTestIdAsync('promptRegistries.item.0');
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining('sourceId=catalog-source'));
        expect(promptRegistriesRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining('itemId=review'));

        const beforeTyping = fixture.daemonRequests.length;
        await act(async () => { screen.changeTextByTestId('promptRegistries.searchQuery', 'missing'); });
        expect(fixture.daemonRequests).toHaveLength(beforeTyping);
        await act(async () => { await screen.findByTestId('promptRegistries.searchQuery')?.props.onSubmitEditing(); });
        await vi.waitFor(() => expect(screen.findByTestId('promptRegistries.item.0')).toBeNull());
        const list = fixture.daemonRequests.filter(request => request.method.endsWith(':daemon.registries.fetch'))
            .map(request => request.params);
        expect(list).toContainEqual({ op: 'list', kind: 'skill', sourceId: 'catalog-source', query: 'missing' });
        expect(catalog.requests).toEqual([]);
    });
});
