import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installPromptAssetsCommonModuleMocks, promptAssetsRouterPushSpy } from './promptAssetsScreenTestHelpers';
const alertSpy = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@happier-dev/iroh-native', async original => (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptAssetsCommonModuleMocks({ storage: original => original(), modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: alertSpy } }).module;
}, reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: ({ ios, default: fallback }: { ios?: unknown; default?: unknown }) => ios ?? fallback } });
} });
const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
installHomeGovernanceBoundaries(createHomeGovernanceHarness());
const { createPromptLibraryCatalogBoundary } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { createPromptMachineTransferFixture, createFoundSkillTransferFixture, installPromptMachineSocketBoundary } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
installPromptMachineSocketBoundary();
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { storage } = await import('@/sync/domains/state/storage');
const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { PromptAssetsScreen } = await import('./PromptAssetsScreen');
const foundSkill = createFoundSkillTransferFixture({ name: 'refactor', path: '/repo/.agents/skills/refactor', scope: 'project', agents: ['claude', 'codex'],
    files: [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: refactor\ndescription: Refactor code\n---\n# Refactor').toString('base64'), contentKind: 'utf8', unixMode: 0o644 },
        { path: 'run.sh', contentBase64: Buffer.from('#!/bin/sh\ntrue').toString('base64'), contentKind: 'utf8', unixMode: 0o755 },
        { path: 'sample.bin', contentBase64: Buffer.from([0, 255, 128]).toString('base64'), contentKind: 'binary', unixMode: 0o644 }] });
let fixture: Awaited<ReturnType<typeof createPromptMachineTransferFixture>>;
let catalog: ReturnType<typeof createPromptLibraryCatalogBoundary>;
let previousState: ReturnType<typeof storage.getState>;
const itemId = 'promptAssets.item.project./repo/.agents/skills.0';
async function setup(workspacePath = '/repo') {
    catalog = createPromptLibraryCatalogBoundary({ records: [
        { key: 'contexts', value: { v: 1, selectionsByKey: { 'promptAssets.externalAssets': { machineId: 'machine-2', workspacePath } } } },
        { key: 'external-links', value: { v: 1, links: [] } },
        { key: 'skill-rules', value: { v: 1, rules: [] } },
    ], revision: 4 });
    fixture = await createPromptMachineTransferFixture({ serverUrl: 'https://prompt-assets-screen.test', serverIdentityId: 'srv_prompt_assets_screen',
        selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets, types: [], foundSkill, handleHomeRequest: catalog.handle });
    await refreshPromptLibraryCatalog(fixture.scope);
}
function requests(method: string) { return fixture.daemonRequests.filter(request => request.method.endsWith(':' + method)); }
async function waitForAsset(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await vi.waitFor(() => expect(screen.findByTestId(itemId), JSON.stringify({ ...fixture.diagnostic(),
        directory: screen.findByTestId('promptAssets.directoryInput')?.props.value,
        alerts: alertSpy.mock.calls, renderedText: screen.findAll(node => typeof node.props.children === 'string').map(node => node.props.children),
    })).not.toBeNull());
}
beforeEach(() => { previousState = storage.getState(); promptAssetsRouterPushSpy.mockReset(); alertSpy.mockReset(); });
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); storage.setState(previousState, true); });

describe('PromptAssetsScreen strict Found Action transition', () => {
    it('adopts a scanned skill through the real Action and transfer with reach and machine provenance', async () => {
        await setup(); const screen = await renderScreen(<PromptAssetsScreen />); await waitForAsset(screen);
        expect(requests('skills.found.list').at(-1)?.params).toEqual({ machineId: 'machine-1', directory: '/repo' });
        await screen.pressByTestIdAsync(itemId);
        await vi.waitFor(() => expect(fixture.artifacts.list()).toHaveLength(1));
        const created = fixture.artifacts.list()[0]!;
        const { decodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        expect(decodePlainArtifactStoredContent(created.header)).toMatchObject({ skillLock: { provenance: { kind: 'machine', machineId: 'machine-1',
            path: foundSkill.bundle.path, agentIds: ['claude', 'codex'] } } });
        const body = JSON.parse(fixture.artifacts.readPlainBody(created.id)!);
        expect(body.entries).toEqual(foundSkill.bundle.files);
        await vi.waitFor(() => expect(catalog.read('skill-rules').value).toMatchObject({ rules: [{ skillId: created.id, target: { t: 'allMachines' }, enabled: true }] }));
        expect(catalog.read('external-links').value).toEqual({ v: 1, links: [] });
        expect(requests('daemon.directTransfer.export.prepare').at(-1)?.params).toEqual({ t: 'prompt_asset_download_v1', path: foundSkill.bundle.path });
        expect(requests('daemon.promptAssets.discover')).toEqual([]);
        expect(requests('daemon.promptAssets.listTypes')).toEqual([]);
        await vi.waitFor(() => expect(promptAssetsRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining(created.id)));
    });
    it('uses Administration and clears project results after a target change', async () => {
        await setup(); const screen = await renderScreen(<PromptAssetsScreen />); await waitForAsset(screen);
        expect(requests('skills.found.list')[0]?.method).toMatch(/^machine-1:/);
        const before = requests('skills.found.list').length;
        await act(async () => { fixture.selectMachine('machine-2'); });
        await vi.waitFor(() => expect(screen.findByTestId(itemId)).toBeNull());
        expect(requests('skills.found.list')).toHaveLength(before);
    });
    it('does not scan a project before a workspace is chosen', async () => {
        await setup(''); await renderScreen(<PromptAssetsScreen />); await act(async () => {});
        expect(requests('skills.found.list')).toEqual([]);
    });
    it.each([
        { changed: 'directory', machineId: 'machine-1' },
        { changed: 'Machine and directory', machineId: 'machine-2' },
    ])('scans the newest $changed after a pending scan without admitting old rows', async ({ machineId }) => {
        await setup();
        const first = createDeferred<void>(), second = createDeferred<void>();
        fixture.beforeNextFoundList(() => first.promise);
        try {
            const screen = await renderScreen(<PromptAssetsScreen />);
            await vi.waitFor(() => expect(requests('skills.found.list')).toHaveLength(1));
            if (machineId === 'machine-2') {
                await act(async () => { fixture.selectMachine(machineId); });
                await vi.waitFor(() => expect(screen.findByTestId('promptAssets.directoryInput')?.props.value).toBe(''));
            }
            const newest = createFoundSkillTransferFixture({ ...foundSkill.bundle, scope: 'project', name: 'newest', path: '/next/.agents/skills/newest' });
            fixture.setFoundList(newest.list); fixture.beforeNextFoundList(() => second.promise);
            await act(async () => { screen.changeTextByTestId('promptAssets.directoryInput', '/next'); });
            await act(async () => { first.resolve(); });
            await vi.waitFor(() => expect(requests('skills.found.list')).toHaveLength(2));
            expect(screen.findByTestId(itemId)).toBeNull();
            expect(requests('skills.found.list').map(request => ({ method: request.method, params: request.params }))).toEqual([
                { method: 'machine-1:skills.found.list', params: { machineId: 'machine-1', directory: '/repo' } },
                { method: `${machineId}:skills.found.list`, params: { machineId, directory: '/next' } },
            ]);
            await act(async () => { second.resolve(); });
            await vi.waitFor(() => expect(screen.findByTestId('promptAssets.item.project./next/.agents/skills.0')).not.toBeNull());
        } finally { first.resolve(); second.resolve(); }
    });
    it('fails closed without an Administration target', async () => {
        await setup(); fixture.selectMachine(null); await renderScreen(<PromptAssetsScreen />); await act(async () => {});
        expect(fixture.daemonRequests).toEqual([]); expect(catalog.requests).toEqual([]);
    });
    it('does not create content after its captured library Account retires during download', async () => {
        await setup(); const screen = await renderScreen(<PromptAssetsScreen />); await waitForAsset(screen);
        fixture.afterNextExport(async () => { await fixture.homes.switchAccount(fixture.serverId, 'replacement-account'); });
        await screen.pressByTestIdAsync(itemId);
        await vi.waitFor(() => expect(alertSpy).toHaveBeenCalled());
        expect(fixture.artifacts.list()).toEqual([]);
        expect(catalog.requests.filter(request => request.key === 'skill-rules')).toEqual([]);
    });
    it('reads the selected Machine Home when its id also exists on the library Home', async () => {
        await setup(); const machineHome = await fixture.addMachineHome('https://found-independent-machine.test', 'srv_found_independent_machine');
        const screen = await renderScreen(<PromptAssetsScreen />); await waitForAsset(screen);
        const before = fixture.homes.requests.length;
        await screen.pressByTestIdAsync(itemId);
        await vi.waitFor(() => expect(fixture.artifacts.list()).toHaveLength(1));
        expect(machineHome.artifacts.list()).toEqual([]);
        expect(fixture.homes.requests.slice(before).filter(request => request.path === '/v1/machines/peer/mediation/route-grants')
            .map(request => request.serverId)).toEqual([machineHome.serverId]);
    });
    it.each([false, true])('uses inLibrary only from the captured library Account (independent Home: %s)', async independent => {
        await setup();
        const machineHome = independent ? await fixture.addMachineHome('https://found-source-library.test', 'srv_found_source_library') : null;
        const sourceArtifacts = machineHome?.artifacts ?? fixture.artifacts;
        const { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const sourceId = 'source-library-only';
        const seeded = await sourceArtifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: sourceId,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'Refactor', bundleSchemaId: 'skills.skill_md_v1' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, entries: foundSkill.bundle.files, createdAtMs: 1, updatedAtMs: 1 }) }),
        }) });
        expect(seeded?.status).toBe(200);
        fixture.setFoundList({ ...foundSkill.list, items: foundSkill.list.items.map(item => ({ ...item, inLibrary: sourceId })) });
        const screen = await renderScreen(<PromptAssetsScreen />); await waitForAsset(screen);
        await screen.pressByTestIdAsync(itemId);
        if (independent) {
            await vi.waitFor(() => expect(fixture.artifacts.list()).toHaveLength(1));
            const created = fixture.artifacts.list()[0]!;
            expect(created.id).not.toBe(sourceId);
            await vi.waitFor(() => expect(promptAssetsRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining(created.id)));
            expect(sourceArtifacts.list().map(artifact => artifact.id)).toEqual([sourceId]);
        } else {
            await vi.waitFor(() => expect(promptAssetsRouterPushSpy).toHaveBeenCalledWith(expect.stringContaining(sourceId)));
            expect(fixture.artifacts.list().map(artifact => artifact.id)).toEqual([sourceId]);
            expect(requests('daemon.directTransfer.export.prepare')).toEqual([]);
        }
    });
});
