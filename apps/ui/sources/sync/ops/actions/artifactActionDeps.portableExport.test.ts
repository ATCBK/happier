import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { LaunchProfileArtifactV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { RoleArtifactV1Schema } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let account: LazyActionAccountContext | undefined;
afterEach(async () => {
    account?.dispose(); account = undefined;
    await fixture?.dispose(); fixture = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const role = RoleArtifactV1Schema.parse({ name: 'Reviewer', instructions: 'Review the changes.',
    runsAs: { kind: 'session' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true });
const profile = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1',
    profile: { id: 'portable-profile', name: 'Review environment', createdAt: 1, updatedAt: 1 } });

it.each([
    { portable: { kind: 'role' as const, document: role }, fileName: 'Reviewer.role.json', document: role },
    { portable: { kind: 'launch-profile' as const, document: profile }, fileName: 'Review-environment.launch-profile.json', document: profile },
])('exports $portable.kind through admission and the existing platform save owner', async ({ portable, fileName, document }) => {
    fixture = await createPlainArtifactHomeFixture('https://portable-export.test');
    account = await captureLazyActionAccountContext(fixture.home.id);
    // Browser downloads are the OS boundary. The Action schema, policy, Account capture,
    // serialization and real saveWorkflowDocument path remain in the production graph.
    const blobs: Blob[] = [];
    const downloaded: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:portable'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { body: { appendChild() {} }, createElement: () => {
        const anchor = { download: '', style: {}, remove() {}, click() { downloaded.push(anchor.download); } };
        return anchor;
    } });
    let settings = normalizeActionsSettingsV1({ v: 1, actions: { 'artifact.export': { enabled: false } } });
    const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
        artifactAction: createUiArtifactAction(account),
        isActionEnabled: (id, ctx) => isActionEnabledByActionsSettings(id, settings, ctx),
    })));
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
        serverId: fixture.home.id, runtimeAccountId: account.accountId, bypassApprovals: true };
    expect(await execute('artifact.export', { portable }, context)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(downloaded).toEqual([]);
    expect(blobs).toEqual([]);
    expect(await execute('artifact.list', {}, context)).toMatchObject({ ok: true });

    settings = normalizeActionsSettingsV1({ v: 1 });
    const spec = getActionSpec('artifact.export');
    expect(resolveActionApprovalRouting({ actionId: 'artifact.export', spec,
        input: { portable }, context: { ...context, bypassApprovals: false } }).required).toBe(true);
    expect(resolveActionExecutionPlacementForInput(spec, { portable })).toBe('client');
    expect(resolveActionExecutionPlacementForInput(spec, { artifactId: 'binary', path: 'copy.bin' })).toBe('machine');
    const result = await execute('artifact.export', { portable }, context);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ ok: true, result: { exported: true, fileName } });
    expect(ArtifactActionOutputSchemasV1['artifact.export'].safeParse(result.result).success).toBe(true);
    expect(downloaded).toEqual([fileName]);
    expect(JSON.parse(await blobs[0]!.text())).toEqual(document);
    expect(fixture.boundary.list()).toEqual([]);
});
