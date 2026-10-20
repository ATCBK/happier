import * as React from 'react';
import { describe, expect, it, onTestFailed, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
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
const { WhereItsOnControl } = await import('@/components/capabilities/where/WhereItsOnControl');
const { SkillAddModal } = await import('./openSkillAddModal');

describe('Skills Add modal through the real Account and registry owners', () => {
    it('installs the reviewed pin, keeps a partial add selected, and retries only its changed rules', async () => {
        let phase = 'admit Home';
        let requests: unknown;
        onTestFailed(() => console.error('Skill Add phase:', phase, 'HTTP:', requests));
        const { home, sourceId, skill, catalog, setRulesUnavailable, moveBranch, externalRequests } =
            await createRegistrySourcesUiHome('modal-partial');
        requests = home.requests;
        const onAdded = vi.fn();
        const onClose = vi.fn();
        phase = 'render';
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ sourceId, onWrite() {}, onAdded }} />);
        phase = 'wait catalog';
        const collection = () => screen.find(node => node.props.testID === 'skills.add:collection' && typeof node.props.model?.actions?.open === 'function');
        // The native host boundary has no measured viewport. Open through the real Collection model, as its row does.
        await waitForHomeGovernance(() => expect(collection().props.model.keys).toContain(`${sourceId}|review`));
        phase = 'open detail';
        await React.act(async () => { collection().props.model.actions.open(`${sourceId}|review`); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')?.props.disabled).toBe(false));
        phase = 'set Where';
        await React.act(async () => {
            await screen.findByType(WhereItsOnControl).props.onChange({ kind: 'replace', rules: [
                { target: { t: 'allMachines' }, enabled: true },
                { target: { t: 'allMachines' }, agentId: 'gemini', enabled: false },
            ] });
        });
        moveBranch();
        setRulesUnavailable(true);
        phase = 'install';
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add.partial.retry')).not.toBeNull());
        expect(onClose).not.toHaveBeenCalled();
        expect(onAdded).not.toHaveBeenCalled();
        const created = home.boundary.list();
        expect(created).toHaveLength(1);
        const skillId = created[0]!.id;
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().artifacts[skillId]?.header).toMatchObject({ skillLock: { provenance: { kind: 'registry', registry: {
            sourceId, itemId: 'review', ref: { commit: skill.item.summary.version },
        } } } });
        expect(externalRequests.some(url => url.endsWith(`/commits/${'b'.repeat(40)}`))).toBe(false);
        setRulesUnavailable(false);
        phase = 'retry rules';
        await screen.pressByTestIdAsync('skills.add.partial.retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add.partial.retry')).toBeNull());
        expect(home.boundary.list().map(row => row.id)).toEqual([skillId]);
        expect(catalog.read('skill-rules').value).toMatchObject({ rules: [
            expect.objectContaining({ skillId, target: { t: 'allMachines' }, enabled: true }),
            expect.objectContaining({ skillId, target: { t: 'allMachines' }, agentId: 'gemini', enabled: false }),
        ] });
        expect(screen.findByTestId(`skills.add:detail:${sourceId}|review`)).not.toBeNull();
    });

    it('opens, rather than adds again, a registry skill the library holds from a link to the same folder', async () => {
        const { home, sourceId } = await createRegistrySourcesUiHome('modal-held-link');
        const onAdded = vi.fn();
        const link = await renderScreen(<SkillAddModal onClose={() => {}} params={{ modeKey: 'link', onWrite() {}, onAdded }} />);
        await React.act(async () => { link.changeTextByTestId('skills.add.link.url', 'https://github.com/fixture/skills/tree/main/review'); });
        await link.pressByTestIdAsync('skills.add.link.find');
        await waitForHomeGovernance(() => expect(link.findByTestId('skills.add.link.add')).not.toBeNull());
        await link.pressByTestIdAsync('skills.add.link.add');
        await waitForHomeGovernance(() => expect(onAdded).toHaveBeenCalled());
        const skillId = home.boundary.list()[0]!.id;
        const screen = await renderScreen(<SkillAddModal onClose={() => {}} params={{ sourceId, onWrite() {}, onAdded: vi.fn() }} />);
        const collection = () => screen.find(node => node.props.testID === 'skills.add:collection' && typeof node.props.model?.actions?.open === 'function');
        await waitForHomeGovernance(() => expect(collection().props.model.keys).toContain(`${sourceId}|review`));
        await React.act(async () => { collection().props.model.actions.open(`${sourceId}|review`); });
        // The list's own match is by registry identity and does not know the link; the preview after the read does.
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('capabilities.skillAdd.open'));
        expect(screen.getTextContent()).not.toContain('capabilities.skillAdd.addToLibrary');
        await screen.pressByTestIdAsync('skills.add:primary');
        expect(home.boundary.list().map(row => row.id)).toEqual([skillId]);
    });
});
