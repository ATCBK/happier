import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, flushHookEffects } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { storage } from '@/sync/domains/state/storage';
import { createSkillPromptBundle, DEFAULT_SKILL_PROMPT_MARKDOWN } from '@/sync/ops/promptLibrary/promptBundles';
import { installSkillBundleCommonModuleMocks } from './skillBundleScreenTestHelpers';
import { PromptEditorHeader } from '../collection/PromptEditorHeader';

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
const { skillBundleRouterReplaceSpy, skillBundleRouterPushSpy } = vi.hoisted(() => ({
    skillBundleRouterReplaceSpy: vi.fn(), skillBundleRouterPushSpy: vi.fn(),
}));
installSkillBundleCommonModuleMocks({ storage: importOriginal => importOriginal() });
// Register platform boundaries in this importing test so they are hoisted before
// testkit/storage imports can cache the default Expo module.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => route.params,
        router: { replace: skillBundleRouterReplaceSpy, push: skillBundleRouterPushSpy }, navigation: { canGoBack: () => false } }).module;
});
// Browser-hosted Monaco is a platform boundary; the real text-input fallback,
// editor draft, bundle codecs, Account capture and Artifact CAS remain active.
vi.mock('@react-navigation/native', async importOriginal => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(),
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
}));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute:
        (await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary')).createFrontDoorActionExecuteForVitest(original) };
});

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
beforeEach(async () => {
    await loadSyncSingletonForTests();
    vi.stubGlobal('window', {});
    skillBundleRouterReplaceSpy.mockClear();
    skillBundleRouterPushSpy.mockClear();
    route.params = {};
});
afterEach(() => { fixture?.dispose(); fixture = undefined; vi.unstubAllGlobals(); });

async function home(foldersUnavailable = false, organizationConflicts = false) {
    const catalog = createPromptLibraryCatalogBoundary({ mutationOutcome: organizationConflicts ? 'conflict' : 'updated' });
    fixture = await createPlainArtifactHomeFixture('https://reviewed-skill-editor.test', { handleRequest: async (path, init) =>
        foldersUnavailable && path.startsWith('/v1/account/entity-rows/prompt-library')
            ? Response.json({ error: 'forbidden' }, { status: 403 }) : catalog.handle(path, init),
    });
    return { ...fixture, catalog };
}
function nativeBody(markdown: string) {
    return { v: 1, entries: [
        { path: 'SKILL.md', contentBase64: Buffer.from(markdown).toString('base64'), contentKind: 'utf8' },
        { path: 'reference.txt', contentBase64: Buffer.from('Retained reference').toString('base64'), contentKind: 'utf8' },
    ], createdAtMs: 1, updatedAtMs: 2 };
}
async function replaceNative(f: NonNullable<typeof fixture>, id: string, markdown: string) {
    const reviewed = f.boundary.read(id);
    if (!reviewed) throw new Error('Missing reviewed Artifact');
    const response = await f.boundary.handle(`/v1/artifacts/${id}`, { method: 'POST', body: JSON.stringify({
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'Review skill', bundleSchemaId: 'skills.skill_md_v1' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(nativeBody(markdown)) }),
        expectedHeaderVersion: reviewed.headerVersion, expectedBodyVersion: reviewed.bodyVersion,
        // Model a readable retained/native row, not a current writer's private
        // metadata envelope still bound to the preceding body revision.
        provenance: null, provenanceDataEncryptionKey: null,
    }) });
    if (!response?.ok) throw new Error('Native winner update failed');
}
async function ready(screen: Awaited<ReturnType<typeof renderScreen>>, markdown: string) {
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe(markdown);
        expect(screen.findByTestId('skillBundle.title')?.props.editable).toBe(true);
    });
}

describe('SkillBundleEditorScreen native review and save', () => {
    it.each(['create', 'update', 'duplicate'] as const)('adopts the %s receipt only after its mounted approval executes', async operation => {
        const catalog = createPromptLibraryCatalogBoundary();
        const actionId = operation === 'update' ? 'prompt_bundle.update' : 'prompt_bundle.create';
        fixture = await createPlainArtifactHomeFixture(`https://approved-skill-${operation}.test`, { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } },
            } } });
            return catalog.handle(path, init);
        } });
        await fixture.hydrateAccountSettings();
        if (operation !== 'create') await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'owned', header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'Owned', bundleSchemaId: 'skills.skill_md_v1' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(nativeBody('Reviewed instructions')) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={operation === 'create' ? null : 'owned'} />);
        await ready(screen, operation === 'create' ? DEFAULT_SKILL_PROMPT_MARKDOWN : 'Reviewed instructions');
        const kind = (header: unknown) => {
            const value = typeof header === 'string' ? decodePlainArtifactStoredContent(header) : null;
            return value && typeof value === 'object' && 'kind' in value ? value.kind : null;
        };
        await act(async () => {
            if (operation === 'duplicate') void screen.findByType(PromptEditorHeader).props.menuActions.find((item: { id: string }) => item.id === 'duplicate').onSelect();
            else {
                screen.changeTextByTestId('skillBundle.title', 'Submitted title');
                if (operation === 'create') {
                    screen.changeTextByTestId('skillBundle.tags', 'Submitted tag');
                    screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Submitted instructions');
                }
            }
        });
        if (operation !== 'duplicate') act(() => { screen.findByTestId('skillBundle.save')!.props.onPress(); });
        await vi.waitFor(() => expect(fixture!.boundary.list().filter(row => kind(row.header) === 'approval_request.v1')).toHaveLength(1));
        const approval = fixture.boundary.list().find(row => kind(row.header) === 'approval_request.v1')!;
        expect(fixture.boundary.list().filter(row => kind(row.header) === 'prompt_bundle.v2')).toHaveLength(operation === 'create' ? 0 : 1);
        expect(skillBundleRouterReplaceSpy).not.toHaveBeenCalled();
        expect(skillBundleRouterPushSpy).not.toHaveBeenCalled();
        if (operation === 'create') {
            const title = screen.findByTestId('skillBundle.title')!;
            const folder = screen.findByTestId('skillBundle.folderName')!;
            const tags = screen.findByTestId('skillBundle.tags')!;
            const markdown = screen.findAllByType('TextInput').find(node => node.props.multiline === true)!;
            expect([title.props.editable, folder.props.editable, tags.props.editable, markdown.props.editable]).toEqual([false, false, false, false]);
            // Native hosts do not emit changes for frozen inputs. The renderer
            // invokes handlers directly, so model attempted typing at that boundary.
            await act(async () => {
                if (title.props.editable !== false) title.props.onChangeText('Later title');
                if (folder.props.editable !== false) folder.props.onChangeText('Later folder');
                if (tags.props.editable !== false) tags.props.onChangeText('Later tags');
                if (markdown.props.editable !== false) markdown.props.onChangeText('Later instructions');
            });
            expect(screen.findByTestId('skillBundle.title')?.props.value).toBe('Submitted title');
            expect(screen.findByTestId('skillBundle.tags')?.props.value).toBe('Submitted tag');
            expect(markdown.props.value).toBe('Submitted instructions');
        }
        if (operation === 'update') await act(async () => { screen.changeTextByTestId('skillBundle.title', 'Later local draft'); });
        expect(await decideApprovalAsInbox(fixture.home.id, approval.id, 'approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        await vi.waitFor(() => {
            expect(fixture!.boundary.list().filter(row => kind(row.header) === 'prompt_bundle.v2')).toHaveLength(operation === 'duplicate' ? 2 : 1);
            if (operation === 'update') expect(decodePlainArtifactStoredContent(fixture!.boundary.read('owned')!.header)).toMatchObject({ title: 'Submitted title' });
            else expect(operation === 'duplicate' ? skillBundleRouterPushSpy : skillBundleRouterReplaceSpy).toHaveBeenCalled();
        });
        if (operation === 'create') {
            const created = fixture.boundary.list().find(row => kind(row.header) === 'prompt_bundle.v2')!;
            expect(decodePlainArtifactStoredContent(created.header)).toMatchObject({ title: 'Submitted title' });
            const createdBody = JSON.parse(fixture.boundary.readPlainBody(created.id)!);
            expect(Buffer.from(createdBody.entries.find((entry: { path: string }) => entry.path === 'SKILL.md').contentBase64, 'base64').toString())
                .toBe('Submitted instructions');
        }
        if (operation === 'update') expect(screen.findByTestId('skillBundle.title')?.props.value).toBe('Later local draft');
    });
    it('keeps a new skill and new folder uncommitted when bundle creation is disabled', async () => {
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPlainArtifactHomeFixture('https://disabled-skill-save.test', { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'prompt_bundle.create': { disabledSurfaces: ['ui'] } } },
            } } });
            return catalog.handle(path, init);
        } });
        await fixture.hydrateAccountSettings();
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={null} />);
        await ready(screen, DEFAULT_SKILL_PROMPT_MARKDOWN);
        await vi.waitFor(() => expect(screen.findByTestId('skillBundle.tags')?.props.editable).toBe(true));
        await act(async () => {
            screen.changeTextByTestId('skillBundle.title', 'Disabled save');
            screen.changeTextByTestId('skillBundle.folderName', 'Uncommitted folder');
        });
        await screen.pressByTestIdAsync('skillBundle.save');
        expect(fixture.boundary.list()).toHaveLength(0);
        expect(catalog.requests).toHaveLength(0);
        expect(catalog.read('folders').value).toMatchObject({ folders: [] });
        expect(screen.findByTestId('skillBundle.folderName')?.props.value).toBe('Uncommitted folder');
        expect(skillBundleRouterReplaceSpy).not.toHaveBeenCalled();
    });

    it('opens the acknowledged new skill in its qualified Home when personal placement loses CAS', async () => {
        const f = await home(false, true);
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={null} serverId={f.home.id} />);
        await ready(screen, DEFAULT_SKILL_PROMPT_MARKDOWN);
        await vi.waitFor(() => expect(screen.findByTestId('skillBundle.tags')?.props.editable).toBe(true));
        await act(async () => {
            screen.changeTextByTestId('skillBundle.title', 'Acknowledged new skill');
            screen.changeTextByTestId('skillBundle.tags', 'Uncommitted personal placement');
            screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Acknowledged instructions');
        });
        await vi.waitFor(() => expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('skillBundle.save');
        await vi.waitFor(() => expect(f.catalog.requests).toHaveLength(1));
        const acknowledged = f.boundary.list()[0];
        expect(acknowledged).toBeDefined();
        expect(decodePlainArtifactStoredContent(acknowledged!.header)).toMatchObject({ title: 'Acknowledged new skill' });
        const body = JSON.parse(f.boundary.readPlainBody(acknowledged!.id)!);
        expect(Buffer.from(body.entries.find((entry: { path: string }) => entry.path === 'SKILL.md').contentBase64, 'base64').toString())
            .toBe('Acknowledged instructions');
        const folders = f.catalog.read('folders');
        if (folders.key !== 'folders') throw new Error('Wrong catalog');
        expect(folders.value.artifactHeadersById?.[acknowledged!.id]).toBeUndefined();
        await vi.waitFor(() => expect(skillBundleRouterReplaceSpy).toHaveBeenCalledWith(
            `/settings/prompts/skills/${acknowledged!.id}?serverId=${encodeURIComponent(f.home.id)}`,
        ));
        expect(f.boundary.list()).toHaveLength(1);
        expect(screen.findByTestId('skillBundle.tags')?.props.value).toBe('Uncommitted personal placement');
    });

    it('saves admitted skill content through Artifact CAS while unavailable folders remain untouched', async () => {
        const f = await home(true);
        const id = 'owned-skill';
        const header = { v: 1, kind: 'prompt_bundle.v2', title: 'Review skill', bundleSchemaId: 'skills.skill_md_v1',
            folderId: 'legacy-folder', tags: ['private'] };
        const body = nativeBody('Original instructions');
        await f.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id,
            header: encodePlainArtifactStoredContent(header),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        // The admitted sync projection and real Home contain the same reviewed version.
        // Native/currentness/CAS owners remain active beneath the editor's save.
        storage.setState({ isDataReady: true, artifacts: { [id]: { id, title: header.title, header,
            body: JSON.stringify(body), access: 'owner', isDecrypted: true, headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 } } });
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={id} />);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('Original instructions');
            expect(screen.findByTestId('skillBundle.title')?.props.editable).toBe(true);
        });
        await vi.waitFor(() => expect(f.requests.some(request => request.path.startsWith('/v1/account/entity-rows/prompt-library')
            && request.method === 'GET')).toBe(true));
        await act(async () => {
            screen.changeTextByTestId('skillBundle.title', 'Edited skill');
            screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Edited instructions');
        });
        await vi.waitFor(() => expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('skillBundle.save');
        await vi.waitFor(() => expect(f.boundary.read(id)).toMatchObject({ headerVersion: 2, bodyVersion: 2 }));
        expect(decodePlainArtifactStoredContent(f.boundary.read(id)!.header)).toMatchObject({
            title: 'Edited skill', folderId: 'legacy-folder', tags: ['private'],
        });
        const savedBody = JSON.parse(f.boundary.readPlainBody(id)!);
        expect(savedBody.createdAtMs).toBe(body.createdAtMs);
        expect(savedBody.entries).toContainEqual(body.entries[1]);
        expect(Buffer.from(savedBody.entries.find((entry: { path: string }) => entry.path === 'SKILL.md').contentBase64, 'base64').toString()).toBe('Edited instructions');
        expect(f.requests.some(request => request.path.startsWith('/v1/account/entity-rows/prompt-library') && request.method !== 'GET')).toBe(false);
    });
    it('creates a real starter skill and opens the saved bundle', async () => {
        const f = await home();
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={null} />);
        await ready(screen, DEFAULT_SKILL_PROMPT_MARKDOWN);
        await act(async () => { screen.changeTextByTestId('skillBundle.title', 'Fresh skill'); });
        await vi.waitFor(() => expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('skillBundle.save');
        await vi.waitFor(() => expect(skillBundleRouterReplaceSpy).toHaveBeenCalled());
        const saved = f.boundary.list()[0];
        expect(saved).toBeDefined();
        const body = JSON.parse(f.boundary.readPlainBody(saved!.id)!);
        expect(Buffer.from(body.entries[0].contentBase64, 'base64').toString()).toBe(DEFAULT_SKILL_PROMPT_MARKDOWN);
        expect(skillBundleRouterReplaceSpy).toHaveBeenCalledWith(`/settings/prompts/skills/${saved!.id}?serverId=${encodeURIComponent(f.home.id)}`);
    });

    it('opens the current native bundle rather than a stale cached review', async () => {
        const f = await home();
        const id = await createSkillPromptBundle({ title: 'Review skill', skillMarkdown: 'Cached original' });
        await replaceNative(f, id, 'Current native instructions');
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={id} />);
        await ready(screen, 'Current native instructions');
        expect(screen.getTextContent()).toContain('reference.txt');
    });

    it('does not disclose a wrong-kind Artifact merely because its body is bundle-shaped', async () => {
        const f = await home();
        const id = await createSkillPromptBundle({ title: 'Review skill', skillMarkdown: 'Private non-skill body' });
        const current = f.boundary.read(id)!;
        const header = { v: 1, kind: 'prompt_doc.v2', title: 'Not a skill' };
        const response = await f.boundary.handle(`/v1/artifacts/${id}`, { method: 'POST', body: JSON.stringify({
            header: encodePlainArtifactStoredContent(header), expectedHeaderVersion: current.headerVersion,
        }) });
        expect(response?.ok).toBe(true);
        const cached = storage.getState().artifacts[id]!;
        storage.setState({ artifacts: { [id]: { ...cached, header, title: header.title, headerVersion: 2 } } });
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={id} />);
        await flushHookEffects();
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).not.toBe('Private non-skill body');
        expect(screen.findByTestId('skillBundle.title')?.props.value).not.toBe('Not a skill');
        expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(true);
    });

    it('preserves the native winner and the unsaved draft when the reviewed revision loses CAS', async () => {
        const f = await home();
        const id = await createSkillPromptBundle({ title: 'Review skill', skillMarkdown: 'Reviewed instructions' });
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={id} />);
        await ready(screen, 'Reviewed instructions');
        await act(async () => { screen.changeTextByTestId('skillBundle.title', 'Unsaved skill draft'); });
        await vi.waitFor(() => expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(false));
        await replaceNative(f, id, 'Concurrent native winner');
        const winner = f.boundary.read(id)!;
        await screen.pressByTestIdAsync('skillBundle.save');
        await flushHookEffects();
        expect(JSON.parse(f.boundary.readPlainBody(id)!)).toEqual(nativeBody('Concurrent native winner'));
        expect(f.boundary.read(id)).toMatchObject({ headerVersion: winner.headerVersion, bodyVersion: winner.bodyVersion });
        expect(screen.findByTestId('skillBundle.title')?.props.value).toBe('Unsaved skill draft');
        expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(false);
        expect(skillBundleRouterReplaceSpy).not.toHaveBeenCalled();
    });

    it('reads and saves the explicitly selected Home without borrowing an active Home cache', async () => {
        const f = await home();
        const id = await createSkillPromptBundle({ title: 'Selected Home skill', skillMarkdown: 'Selected Home instructions' });
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const other = await upsertAndActivateServer({ serverUrl: 'https://other-skill-home.test', scope: 'device' });
        const accountId = storage.getState().profileScope!.accountId;
        storage.setState({ settingsScope: { serverId: other.id, accountId }, profileScope: { serverId: other.id, accountId },
            artifacts: { [id]: { id, title: 'Wrong Home', header: { title: 'Wrong Home', kind: 'prompt_bundle.v2' },
                body: JSON.stringify(nativeBody('Wrong Home private instructions')), access: 'owner', isDecrypted: true,
                headerVersion: 8, bodyVersion: 8, seq: 1, createdAt: 1, updatedAt: 1 } } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        route.params = { id, serverId: f.home.id };
        const { EditSkillBundlePage } = await import('@/app/(app)/settings/prompts/skills/[id]');
        const screen = await renderScreen(<EditSkillBundlePage />);
        await ready(screen, 'Selected Home instructions');
        await act(async () => { screen.changeTextByTestId('skillBundle.title', 'Edited selected skill'); });
        await screen.pressByTestIdAsync('skillBundle.save');
        await vi.waitFor(() => expect(decodePlainArtifactStoredContent(f.boundary.read(id)!.header)).toMatchObject({ title: 'Edited selected skill' }));
        expect(JSON.parse(f.boundary.readPlainBody(id)!)).toMatchObject({ entries: [{ path: 'SKILL.md',
            contentBase64: Buffer.from('Selected Home instructions').toString('base64') }] });
        expect(storage.getState().artifacts[id]?.headerVersion).toBe(8);
    });

    it('discards reviewed private content and refuses mutation when its Account lifetime retires', async () => {
        const f = await home();
        const id = await createSkillPromptBundle({ title: 'Private skill', skillMarkdown: 'Private instructions' });
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={id} />);
        await ready(screen, 'Private instructions');
        await act(async () => { screen.changeTextByTestId('skillBundle.title', 'Private draft'); });
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        await act(async () => { retireActiveServerAccountScopeLifetime(); });
        await flushHookEffects();
        expect(screen.findByTestId('skillBundle.title')?.props.value).toBe('');
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).not.toBe('Private instructions');
        expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(true);
        expect(f.boundary.read(id)).toMatchObject({ headerVersion: 1, bodyVersion: 1 });
    });

    it('keeps a committed content receipt when placement fails so a later deliberate edit uses that revision', async () => {
        const f = await home(false, true);
        const id = await createSkillPromptBundle({ title: 'Reviewed skill', skillMarkdown: 'Reviewed instructions' });
        const { SkillBundleEditorScreen } = await import('./SkillBundleEditorScreen');
        const screen = await renderScreen(<SkillBundleEditorScreen artifactId={id} />);
        await ready(screen, 'Reviewed instructions');
        await vi.waitFor(() => expect(screen.findByTestId('skillBundle.tags')?.props.editable).toBe(true));
        await act(async () => {
            screen.changeTextByTestId('skillBundle.title', 'First committed content');
            screen.changeTextByTestId('skillBundle.tags', 'Uncommitted personal placement');
            screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('First submitted instructions');
        });
        await screen.pressByTestIdAsync('skillBundle.save');
        await vi.waitFor(() => expect(f.boundary.read(id)).toMatchObject({ headerVersion: 2, bodyVersion: 2 }));
        expect(f.catalog.requests).toHaveLength(1);
        await flushHookEffects();
        expect(screen.findByTestId('skillBundle.tags')?.props.value).toBe('Uncommitted personal placement');
        expect(screen.findByTestId('skillBundle.save')?.props.disabled).toBe(false);
        await act(async () => {
            screen.changeTextByTestId('skillBundle.title', 'Second deliberate content');
            screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Second deliberate instructions');
        });
        await screen.pressByTestIdAsync('skillBundle.save');
        await vi.waitFor(() => expect(f.boundary.read(id)).toMatchObject({ headerVersion: 3, bodyVersion: 3 }));
        expect(decodePlainArtifactStoredContent(f.boundary.read(id)!.header)).toMatchObject({ title: 'Second deliberate content' });
        expect(f.catalog.requests).toHaveLength(2);
        const folders = f.catalog.read('folders');
        if (folders.key !== 'folders') throw new Error('Wrong catalog');
        expect(folders.value.artifactHeadersById?.[id]).toBeUndefined();
        const body = JSON.parse(f.boundary.readPlainBody(id)!);
        expect(Buffer.from(body.entries.find((entry: { path: string }) => entry.path === 'SKILL.md').contentBase64, 'base64').toString())
            .toBe('Second deliberate instructions');
        expect(screen.findByTestId('skillBundle.tags')?.props.value).toBe('Uncommitted personal placement');
    });
});
