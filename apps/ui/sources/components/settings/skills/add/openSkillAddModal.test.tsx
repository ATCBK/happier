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
    for (const rulesUnavailable of [false, true]) it(`keeps missing batch content recoverable after an acknowledgment (rules unavailable: ${rulesUnavailable})`, async () => {
        const { createPromptRegistrySkillFixture } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
        const skills = ['review', 'lint'].map(name => createPromptRegistrySkillFixture({ sourceId: 'fixture', itemId: name, title: name,
            files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Check changes\n---\nCheck the changes.` }] }));
        const fixture = await createRegistrySourcesUiHome(`missing-batch-${rulesUnavailable}`, { external: async url => {
            if (url.includes('/git/trees/')) return Response.json({ sha: 'a'.repeat(40), tree: skills.flatMap(skill => {
                if (skill.item.payload.kind !== 'skill') throw new Error('Expected skill fixture');
                const payload = skill.item.payload.skill;
                return [{ path: payload.ref.path, type: 'tree', mode: '040000', sha: payload.ref.treeSha },
                    ...payload.files.map(file => ({ path: `${payload.ref.path}/${file.path}`, type: 'blob', mode: '100644', sha: file.blobSha, size: file.size }))];
            }) });
            if (url.startsWith('https://raw.githubusercontent.com/fixture/skills/')) {
                const skill = skills.find(skill => url.endsWith(`/${skill.item.summary.itemId}/SKILL.md`));
                if (skill) return new Response(Buffer.from(skill.files[0]!.contentBase64, 'base64').toString('utf8'));
            }
            return null;
        } });
        const onAdded = vi.fn(), onClose = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ modeKey: 'link', onWrite() {}, onAdded }} />);
        const addBusy = () => screen.find(node => node.props?.testID === 'skills.add.link.add' && typeof node.props.loading === 'boolean').props.loading;
        await React.act(async () => { screen.changeTextByTestId('skills.add.link.url', 'https://github.com/fixture/skills'); });
        await screen.pressByTestIdAsync('skills.add.link.find');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add.link.add')).not.toBeNull());
        fixture.setContentUnavailableAfter(1);
        fixture.setRulesUnavailable(rulesUnavailable);
        await screen.pressByTestIdAsync('skills.add.link.add');
        await waitForHomeGovernance(() => expect(fixture.home.boundary.list()).toHaveLength(1));
        await waitForHomeGovernance(() => expect(addBusy()).toBe(false));
        const acknowledgedId = fixture.home.boundary.list()[0]!.id;
        expect(onAdded).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('skills.add.link.add-error')).not.toBeNull();
        // A successful rules-only repair must leave the separate content failure visible.
        fixture.setRulesUnavailable(false);
        await screen.pressByTestIdAsync('skills.add.link.add');
        await waitForHomeGovernance(() => expect(addBusy()).toBe(false));
        expect(onAdded).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('skills.add.link.add-error')).not.toBeNull();
        expect(fixture.home.boundary.list().map(row => row.id)).toEqual([acknowledgedId]);
        const row = fixture.catalog.read('skill-rules');
        if (row.key !== 'skill-rules') throw new Error('Expected skill rules');
        expect(row.value.rules.map(rule => rule.skillId)).toContain(acknowledgedId);
        fixture.setContentUnavailableAfter(null);
        await screen.pressByTestIdAsync('skills.add.link.add');
        await waitForHomeGovernance(() => expect(onAdded).toHaveBeenCalledExactlyOnceWith(acknowledgedId));
        expect(onClose).toHaveBeenCalledOnce();
        expect(fixture.home.boundary.list()).toHaveLength(2);
        expect(fixture.home.boundary.list().map(row => row.id)).toContain(acknowledgedId);
    });

    it('keeps a shelf partial acknowledgment recoverable even when the new content is already in the library', async () => {
        let phase = 'create Home';
        onTestFailed(() => console.error('Shelf recovery phase:', phase));
        const { home, sourceId, skill, catalog, setRulesUnavailable } = await createRegistrySourcesUiHome('shelf-partial');
        const { SkillsRegistryShelf } = await import('../SkillsRegistryShelf');
        const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
        function Shelf() {
            const library = useSkillsLibrary();
            return <SkillsRegistryShelf library={library} shelf={{ items: [skill.item.summary], sourceId, loading: false }} brandNew={false} />;
        }
        phase = 'render';
        const screen = await renderScreen(<Shelf />);
        const { RegistryShelf } = await import('@/components/capabilities/add/RegistryShelf');
        // The renderer's native Collection has no measured grid viewport. Render its real action slot explicitly.
        const actionElement = () => <>{screen.findByType(RegistryShelf).props.action(skill.item.summary)}</>;
        const action = await renderScreen(actionElement());
        setRulesUnavailable(true);
        phase = 'press Add';
        await action.pressByTestIdAsync('skills.home.shelf.review.add');
        phase = 'wait content';
        await waitForHomeGovernance(() => expect(home.boundary.list()).toHaveLength(1));
        await action.update(actionElement());
        expect(action.findByTestId('skills.home.shelf.review.partial')).not.toBeNull();
        expect(action.findByTestId('skills.home.shelf.review.added')).toBeNull();
        const skillId = home.boundary.list()[0]!.id;
        setRulesUnavailable(false);
        await action.pressByTestIdAsync('skills.home.shelf.review.partial-action');
        await waitForHomeGovernance(() => expect(catalog.read('skill-rules').value).toMatchObject({ rules: [expect.objectContaining({ skillId, enabled: true })] }));
        await action.update(actionElement());
        expect(action.findByTestId('skills.home.shelf.review.added')).not.toBeNull();
        expect(home.boundary.list().map(row => row.id)).toEqual([skillId]);
        expect(catalog.read('skill-rules').value).toMatchObject({ rules: [expect.objectContaining({ skillId, enabled: true })] });
    });

    it('retains and repairs all sibling rule acknowledgments through the real install Action', async () => {
        let phase = 'create Home';
        onTestFailed(() => console.error('Sibling recovery phase:', phase));
        const { createPromptRegistrySkillFixture } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
        const sibling = createPromptRegistrySkillFixture({ sourceId: 'fixture', itemId: 'lint', title: 'lint', files: [
            { path: 'SKILL.md', content: '---\nname: lint\ndescription: Check style\n---\nCheck the style.' },
        ] });
        if (sibling.item.payload.kind !== 'skill') throw new Error('Expected skill');
        const siblingPayload = sibling.item.payload.skill;
        const primary = createPromptRegistrySkillFixture({ sourceId: 'fixture', itemId: 'review', title: 'review', files: [
            { path: 'SKILL.md', content: '---\nname: review\ndescription: Review changes\n---\nUse [lint](../lint/SKILL.md).' },
            { path: 'check.sh', content: '#!/bin/sh\nexit 0', unixMode: 0o755 },
        ] });
        if (primary.item.payload.kind !== 'skill') throw new Error('Expected skill');
        const main = primary.item.payload.skill;
        const fixture = await createRegistrySourcesUiHome('modal-sibling-partial', { external: async url => {
            if (url.includes('/git/trees/')) {
                return Response.json({ sha: main.ref.treeSha, tree: [
                    { path: 'review', type: 'tree', mode: '040000', sha: main.ref.treeSha },
                    ...main.files.map(file => ({ path: `review/${file.path}`, type: 'blob', mode: file.unixMode === 0o755 ? '100755' : '100644', sha: file.blobSha, size: file.size })),
                    { path: 'lint', type: 'tree', mode: '040000', sha: siblingPayload.ref.treeSha },
                    ...siblingPayload.files.map(file => ({ path: `lint/${file.path}`, type: 'blob', mode: '100644', sha: file.blobSha, size: file.size })),
                ] });
            }
            if (url.startsWith('https://raw.githubusercontent.com/fixture/skills/') && url.endsWith('/review/SKILL.md'))
                return new Response('---\nname: review\ndescription: Review changes\n---\nUse [lint](../lint/SKILL.md).');
            if (url.startsWith('https://raw.githubusercontent.com/fixture/skills/') && url.endsWith('/lint/SKILL.md'))
                return new Response(Buffer.from(sibling.files[0]!.contentBase64, 'base64').toString('utf8'));
            return null;
        } });
        const onClose = vi.fn();
        const onAdded = vi.fn();
        phase = 'render';
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ sourceId: fixture.sourceId, onWrite() {}, onAdded }} />);
        const collection = () => screen.find(node => node.props.testID === 'skills.add:collection' && typeof node.props.model?.actions?.open === 'function');
        phase = 'wait catalog';
        await waitForHomeGovernance(() => expect(collection().props.model.keys).toContain(`${fixture.sourceId}|review`));
        phase = 'open detail';
        await React.act(async () => { collection().props.model.actions.open(`${fixture.sourceId}|review`); });
        phase = 'wait detail';
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary')?.props.disabled).toBe(false));
        fixture.setRulesUnavailable(true);
        phase = 'install';
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary-error')).not.toBeNull());
        expect(fixture.home.boundary.list()).toHaveLength(2);
        const ids = fixture.home.boundary.list().map(row => row.id).sort();
        // Re-pressing the main action is also recovery: it must never recreate either acknowledged skill.
        phase = 'repeat primary';
        await screen.pressByTestIdAsync('skills.add:primary');
        expect(fixture.home.boundary.list().map(row => row.id).sort()).toEqual(ids);
        fixture.setRulesUnavailable(false);
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary-error')).toBeNull());
        const row = fixture.catalog.read('skill-rules');
        expect(row.key).toBe('skill-rules');
        if (row.key !== 'skill-rules') throw new Error('Expected rules');
        expect(row.value.rules.map(rule => rule.skillId).sort()).toEqual(ids);
        expect(fixture.home.boundary.list().map(row => row.id).sort()).toEqual(ids);
        expect(onClose).not.toHaveBeenCalled();
        expect(onAdded).not.toHaveBeenCalled();
    });

    it('installs the reviewed pin, keeps a partial add selected, and retries only its changed rules', async () => {
        let phase = 'admit Home';
        onTestFailed(() => console.error('Skill Add phase:', phase));
        const { home, sourceId, skill, catalog, setRulesUnavailable, moveBranch, externalRequests } =
            await createRegistrySourcesUiHome('modal-partial');
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
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary-error')).not.toBeNull());
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
        await screen.pressByTestIdAsync('skills.add:primary');
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add:primary-error')).toBeNull());
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
    it('draws a registry that lists no skills as an empty state that leads on to writing one', async () => {
        const { sourceId } = await createRegistrySourcesUiHome('modal-empty-registry', { external: async url =>
            url.includes('/git/trees/') ? Response.json({ sha: 'a'.repeat(40), tree: [] }) : null });
        const onClose = vi.fn(), onWrite = vi.fn();
        const screen = await renderScreen(<SkillAddModal onClose={onClose} params={{ sourceId, onWrite, onAdded: vi.fn() }} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('skills.add.empty')).not.toBeNull());
        expect(screen.getTextContent()).toContain('capabilities.skillAdd.emptyTitle');
        await screen.pressByTestIdAsync('skills.add.empty.write');
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onWrite).toHaveBeenCalledTimes(1);
    });
});
