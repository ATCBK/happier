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

it('publishes a present user copy from the captured session and retains private file provenance', async () => {
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
        input: { path: 'docs/note.txt', title: 'Review notes' },
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: fixture.home.id, runtimeAccountId: account.accountId, defaultSessionId: session.id } });
    const receipt = ArtifactActionOutputSchemasV1['artifact.publish_from_file'].parse(result);
    const stored = fixture.boundary.read(receipt.artifactId)!;
    expect(decodePlainArtifactStoredContent(stored.header)).toMatchObject({ title: 'Review notes' });
    expect(fixture.boundary.readPlainBody(receipt.artifactId)).toBe('A frozen copy\n');
    const opened = await account.readArtifact(receipt.artifactId);
    expect(opened?.provenance).toMatchObject({
        savedBy: { kind: 'person', accountId: account.accountId },
        source: { sessionId: session.id, machineId: 'source-machine', path: 'docs/note.txt' },
    });
});
