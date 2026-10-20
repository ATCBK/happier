import { afterEach, expect, it, vi } from 'vitest';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { getStorage } from '@/sync/domains/state/storage';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let account: LazyActionAccountContext | undefined;
const initialState = getStorage().getState();
afterEach(async () => {
    account?.dispose(); account = undefined;
    await fixture?.dispose(); fixture = undefined;
    getStorage().setState(initialState, true);
    vi.restoreAllMocks();
});

it.each(['session', 'workspace'] as const)('publishes a present user copy from the captured %s and retains private file provenance', async sourceKind => {
    fixture = await createPlainArtifactHomeFixture('https://file-publication-ui.test');
    account = await captureLazyActionAccountContext(fixture.home.id);
    const session = createSessionFixture({ id: 'source-session', serverId: fixture.home.id,
        metadata: { ...createSessionFixture().metadata!, path: '/repo', machineId: 'source-machine', host: 'source-host' } });
    getStorage().setState({ sessions: { [session.id]: session },
        machineListByServerId: { [fixture.home.id]: [createMachineFixture({ id: 'source-machine' })] } });
    const execute = createUiArtifactAction(account, {
        // Machine transfer is the system boundary; all source admission and Artifact codecs stay real.
        workspaceDownload: async request => {
            expect(request.machineId).toBe('source-machine');
            expect(request.rootPath).toBe('/repo');
            expect(request.request.path).toBe('docs/note.txt');
            await request.destination.writeBytes(new TextEncoder().encode('A frozen copy\n'));
            return { ok: true, name: 'note.txt', sizeBytes: 14 };
        },
    });
    const result = await execute({ actionId: 'artifact.publish_from_file',
        input: { path: 'docs/note.txt', title: 'Review notes',
            ...(sourceKind === 'workspace' ? { workspace: { machineId: 'source-machine', rootPath: '/repo' } } : {}) },
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: fixture.home.id, runtimeAccountId: account.accountId,
            defaultSessionId: sourceKind === 'session' ? session.id : 'ambient-session-not-the-source' } });
    const receipt = ArtifactActionOutputSchemasV1['artifact.publish_from_file'].parse(result);
    const stored = fixture.boundary.read(receipt.artifactId)!;
    expect(decodePlainArtifactStoredContent(stored.header)).toMatchObject({ title: 'Review notes' });
    expect(fixture.boundary.readPlainBody(receipt.artifactId)).toBe('A frozen copy\n');
    const opened = await account.readArtifact(receipt.artifactId);
    expect(opened?.provenance).toMatchObject({
        savedBy: { kind: 'person', accountId: account.accountId },
        source: { ...(sourceKind === 'session' ? { sessionId: session.id } : { rootPath: '/repo' }),
            machineId: 'source-machine', path: 'docs/note.txt' },
    });
    if (sourceKind === 'workspace') expect(opened?.provenance?.source).not.toHaveProperty('sessionId');
});

it.each([
    { rootPath: '/repo', path: '~notes.txt', relativePath: '~notes.txt' },
    { rootPath: 'C:\\repo', path: 'docs\\note.txt', relativePath: 'docs/note.txt' },
])('publishes a literal selected entry $path from $rootPath without home expansion', async ({ rootPath, path, relativePath }) => {
    fixture = await createPlainArtifactHomeFixture('https://workspace-publication-selected-entry.test');
    account = await captureLazyActionAccountContext(fixture.home.id);
    getStorage().setState({ sessions: {}, machineListByServerId: {
        [fixture.home.id]: [createMachineFixture({ id: 'source-machine' })],
    } });
    const execute = createUiArtifactAction(account, { workspaceDownload: async request => {
        expect(request.rootPath).toBe(rootPath);
        expect(request.request.path).toBe(relativePath);
        expect(request.confinedToWorkingDirectory).toBe(true);
        await request.destination.writeBytes(new TextEncoder().encode('Selected bytes'));
        return { ok: true, name: relativePath.split('/').at(-1)!, sizeBytes: 14 };
    } });
    const result = await execute({
        actionId: 'artifact.publish_from_file', input: { path, workspace: { machineId: 'source-machine', rootPath } },
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: fixture.home.id, runtimeAccountId: account.accountId },
    });
    expect(result).toMatchObject({ artifactId: expect.any(String), revision: expect.any(Object) });
    const receipt = ArtifactActionOutputSchemasV1['artifact.publish_from_file'].parse(result);
    expect(fixture.boundary.readPlainBody(receipt.artifactId)).toBe('Selected bytes');
    expect((await account.readArtifact(receipt.artifactId))?.provenance?.source).toMatchObject({
        machineId: 'source-machine', rootPath, path: relativePath,
    });
});

it.each(['missing-machine', 'locked-machine', 'escaped-path', 'foreign-account'] as const)(
    'refuses %s before reading or publishing a workspace copy', async refusal => {
    fixture = await createPlainArtifactHomeFixture(`https://workspace-publication-${refusal}.test`);
    account = await captureLazyActionAccountContext(fixture.home.id);
    getStorage().setState({ machineListByServerId: { [fixture.home.id]: refusal === 'missing-machine' ? [] : [
        createMachineFixture({ id: 'source-machine', ...(refusal === 'locked-machine'
            ? { availability: { kind: 'locked', reason: 'encryption_material_unavailable' } } : {}) }),
    ] } });
    const download = vi.fn();
    const execute = createUiArtifactAction(account, { workspaceDownload: download });
    const result = await execute({ actionId: 'artifact.publish_from_file', input: {
        path: refusal === 'escaped-path' ? '../outside.txt' : 'docs/note.txt',
        workspace: { machineId: 'source-machine', rootPath: '/repo' },
    }, context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: fixture.home.id, runtimeAccountId: refusal === 'foreign-account' ? 'not-the-captured-account' : account.accountId } });
    expect(result).toMatchObject({ ok: false, errorCode: refusal === 'escaped-path'
        ? 'artifact_source_forbidden' : 'artifact_source_unavailable' });
    expect(download).not.toHaveBeenCalled();
    expect(fixture.boundary.list()).toHaveLength(0);
});
