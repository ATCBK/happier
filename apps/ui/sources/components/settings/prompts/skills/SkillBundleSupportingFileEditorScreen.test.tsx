import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPromptBundleArtifact } from '@/sync/ops/promptLibrary/promptBundles';
import { storage } from '@/sync/domains/state/storage';
import { installSkillBundleCommonModuleMocks } from './skillBundleScreenTestHelpers';

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
const { skillBundleRouterReplaceSpy } = vi.hoisted(() => ({ skillBundleRouterReplaceSpy: vi.fn() }));
installSkillBundleCommonModuleMocks({ storage: importOriginal => importOriginal() });
// Hoist platform boundaries in the importing test before testkit/storage can
// cache the default Expo module; keep the internal store and Actions real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => route.params, router: { replace: skillBundleRouterReplaceSpy },
        navigation: { canGoBack: () => false } }).module;
});
// Navigation and browser-hosted Monaco are platform boundaries; draft, codecs,
// captured Account authority and the Artifact HTTP/CAS path stay real.
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
    route.params = {};
});
afterEach(() => { fixture?.dispose(); fixture = undefined; vi.unstubAllGlobals(); });

function body(content: string) {
    return { v: 1, createdAtMs: 1, updatedAtMs: 2, entries: [
        { path: 'SKILL.md', contentBase64: Buffer.from('Skill instructions').toString('base64'), contentKind: 'utf8' as const },
        { path: 'templates/review.md', contentBase64: Buffer.from(content).toString('base64'), contentKind: 'utf8' as const },
    ] };
}
async function home(updateDisabled = false, updateRequiresApproval = false) {
    const catalog = createPromptLibraryCatalogBoundary();
    fixture = await createPlainArtifactHomeFixture('https://reviewed-skill-supporting-editor.test', { handleRequest: async (path, init) => {
        if ((updateDisabled || updateRequiresApproval) && path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'prompt_bundle.update': updateDisabled
                ? { disabledSurfaces: ['ui'] } : { approvalRequiredSurfaces: ['ui'] } } },
        } } });
        return catalog.handle(path, init);
    } });
    await fixture.hydrateAccountSettings();
    const id = await createPromptBundleArtifact({ title: 'Skill title', bundleSchemaId: 'skills.skill_md_v1', entries: body('review template').entries });
    return { fixture, id };
}
async function replaceNative(f: NonNullable<typeof fixture>, id: string, content: string) {
    const reviewed = f.boundary.read(id)!;
    const result = await f.boundary.handle(`/v1/artifacts/${id}`, { method: 'POST', body: JSON.stringify({
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(body(content)) }),
        expectedBodyVersion: reviewed.bodyVersion,
        // Direct fixture writes represent retained/native content without a
        // stale private metadata envelope bound to its previous body revision.
        provenance: null, provenanceDataEncryptionKey: null,
    }) });
    if (!result?.ok) throw new Error('Native update failed');
}
async function renderEditor(id: string, path: string | null) {
    const { SkillBundleSupportingFileEditorScreen } = await import('./SkillBundleSupportingFileEditorScreen');
    const screen = await renderScreen(<SkillBundleSupportingFileEditorScreen artifactId={id} path={path} />);
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('promptLibrary.surface.supportingFileDescription');
        expect(screen.findByTestId('skillSupportingFile.save')?.props.disabled).toBe(path === null);
    });
    return screen;
}
function savedEntry(f: NonNullable<typeof fixture>, id: string, path: string) {
    const stored = JSON.parse(f.boundary.readPlainBody(id)!);
    const entry = stored.entries.find((candidate: { path: string }) => candidate.path === path);
    return entry ? Buffer.from(entry.contentBase64, 'base64').toString() : null;
}

describe('SkillBundleSupportingFileEditorScreen reviewed native content', () => {
    it('freezes the submitted supporting file until its mounted approval executes', async () => {
        const { fixture: f, id } = await home(false, true);
        const screen = await renderEditor(id, null);
        await act(async () => {
            screen.changeTextByTestId('skillSupportingFile.path', 'docs/submitted.md');
            screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Submitted supporting content');
        });
        act(() => { screen.findByTestId('skillSupportingFile.save')!.props.onPress(); });
        await vi.waitFor(() => expect(f.boundary.list().some(row => {
            const header = decodePlainArtifactStoredContent(row.header);
            return header && typeof header === 'object' && 'kind' in header && header.kind === 'approval_request.v1';
        })).toBe(true));
        const approval = f.boundary.list().find(row => {
            const header = decodePlainArtifactStoredContent(row.header);
            return header && typeof header === 'object' && 'kind' in header && header.kind === 'approval_request.v1';
        })!;
        expect(savedEntry(f, id, 'docs/submitted.md')).toBeNull();
        expect(skillBundleRouterReplaceSpy).not.toHaveBeenCalled();
        const path = screen.findByTestId('skillSupportingFile.path')!;
        const content = screen.findAllByType('TextInput').find(node => node.props.multiline === true)!;
        expect([path.props.editable, content.props.editable]).toEqual([false, false]);
        // Honor the native editable boundary when attempting later input.
        await act(async () => {
            if (path.props.editable !== false) path.props.onChangeText('docs/later.md');
            if (content.props.editable !== false) content.props.onChangeText('Later supporting content');
        });
        expect(screen.findByTestId('skillSupportingFile.path')?.props.value).toBe('docs/submitted.md');
        expect(content.props.value).toBe('Submitted supporting content');
        expect(await decideApprovalAsInbox(f.home.id, approval.id, 'approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        await vi.waitFor(() => expect(skillBundleRouterReplaceSpy).toHaveBeenCalled());
        expect(savedEntry(f, id, 'docs/submitted.md')).toBe('Submitted supporting content');
        expect(savedEntry(f, id, 'docs/later.md')).toBeNull();
        expect(savedEntry(f, id, 'templates/review.md')).toBe('review template');
    });
    it('preserves the supporting-file draft and stored bundle when update admission is disabled', async () => {
        const { fixture: f, id } = await home(true);
        const screen = await renderEditor(id, 'templates/review.md');
        await act(async () => { screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Denied template'); });
        await screen.pressByTestIdAsync('skillSupportingFile.save');
        expect(savedEntry(f, id, 'templates/review.md')).toBe('review template');
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('Denied template');
        expect(skillBundleRouterReplaceSpy).not.toHaveBeenCalled();
    });
    it('loads the current native supporting file rather than an ambient cached body and saves its reviewed revision', async () => {
        const { fixture: f, id } = await home();
        await replaceNative(f, id, 'Current native template');
        const screen = await renderEditor(id, 'templates/review.md');
        expect(screen.findByTestId('skillSupportingFile.path')?.props.value).toBe('templates/review.md');
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('Current native template');
        await act(async () => { screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Updated template'); });
        await screen.pressByTestIdAsync('skillSupportingFile.save');
        await vi.waitFor(() => expect(savedEntry(f, id, 'templates/review.md')).toBe('Updated template'));
        expect(savedEntry(f, id, 'SKILL.md')).toBe('Skill instructions');
    });

    it('creates a new supporting file entry while preserving existing bundle entries', async () => {
        const { fixture: f, id } = await home();
        const screen = await renderEditor(id, null);
        await act(async () => {
            screen.changeTextByTestId('skillSupportingFile.path', 'docs/checklist.md');
            screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Checklist body');
        });
        await vi.waitFor(() => expect(screen.findByTestId('skillSupportingFile.save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('skillSupportingFile.save');
        await vi.waitFor(() => expect(savedEntry(f, id, 'docs/checklist.md')).toBe('Checklist body'));
        expect(savedEntry(f, id, 'templates/review.md')).toBe('review template');
    });

    it('preserves the native winner and supporting-file draft when the reviewed body revision loses CAS', async () => {
        const { fixture: f, id } = await home();
        const screen = await renderEditor(id, 'templates/review.md');
        await act(async () => { screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Unsaved template draft'); });
        await replaceNative(f, id, 'Native winner template');
        const winner = f.boundary.read(id)!;
        await screen.pressByTestIdAsync('skillSupportingFile.save');
        await flushHookEffects();
        expect(f.boundary.read(id)).toEqual(winner);
        expect(savedEntry(f, id, 'templates/review.md')).toBe('Native winner template');
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('Unsaved template draft');
        expect(screen.findByTestId('skillSupportingFile.save')?.props.disabled).toBe(false);
        expect(skillBundleRouterReplaceSpy).not.toHaveBeenCalled();
    });

    it('consumes the supporting-file route Home instead of an active Home same-id cache', async () => {
        const { fixture: f, id } = await home();
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const other = await upsertAndActivateServer({ serverUrl: 'https://other-skill-supporting-home.test', scope: 'device' });
        const accountId = storage.getState().profileScope!.accountId;
        storage.setState({ settingsScope: { serverId: other.id, accountId }, profileScope: { serverId: other.id, accountId },
            artifacts: { [id]: { id, title: 'Foreign skill', header: { title: 'Foreign skill', kind: 'prompt_bundle.v2' },
                body: JSON.stringify(body('Foreign private template')), access: 'owner', isDecrypted: true,
                headerVersion: 8, bodyVersion: 8, seq: 1, createdAt: 1, updatedAt: 1 } } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        route.params = { id, serverId: f.home.id, path: 'templates/review.md' };
        const { EditSkillSupportingFilePage } = await import('@/app/(app)/settings/prompts/skills/[id]/files/edit');
        const screen = await renderScreen(<EditSkillSupportingFilePage />);
        await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('review template'); });
        await act(async () => { screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Selected Home update'); });
        await screen.pressByTestIdAsync('skillSupportingFile.save');
        await vi.waitFor(() => expect(savedEntry(f, id, 'templates/review.md')).toBe('Selected Home update'));
        expect(storage.getState().artifacts[id]?.bodyVersion).toBe(8);
    });

    it('clears reviewed private supporting content when the captured Account retires', async () => {
        const { id } = await home();
        const screen = await renderEditor(id, 'templates/review.md');
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        await act(async () => { retireActiveServerAccountScopeLifetime(); });
        await flushHookEffects();
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('');
        expect(screen.findByTestId('skillSupportingFile.save')?.props.disabled).toBe(true);
    });
});
