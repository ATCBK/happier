import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastify from 'fastify';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionInputV1Schema,
    PluginAvailabilityIntentReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability/actions';
import { describe, expect, it, vi } from 'vitest';
import { readProcessCensus, type ProcessStartIdentity } from '@/processes/census/processCensus';
import { parseProcessOwnerTag } from '@/processes/ownerTag';
import { projectPath } from '@/projectPath';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';

import { runPackedPluginTest } from '../authoring/packedTest';
import { createDaemonPluginRuntimeOwner } from '../daemon/runtimeOwner';
import { createPackedTestConnectedAccountsRuntime } from '../daemon/packedTestConnectedAccounts';
import { createResolvedContributionRegistry } from '../projection/registry/createResolvedContributionRegistry';
import { executeContributedAction } from '../runtime/invocation/actions/executeContributedAction';
import { createPluginReloadController } from '../runtime/reload/controller';
import { resolveExecutablePluginRuntimeRegistry } from '../runtime/resolveExecutablePluginRuntimeRegistry';
import { packLocalPlugin } from './pack';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';

const fixtureRoot = fileURLToPath(new URL(
    '../testkit/fixtures/packed-external-background-service', import.meta.url,
));

type InstalledBackgroundService = Readonly<{
    registry: NonNullable<ReturnType<ReturnType<typeof createPluginReloadController>['getState']>['activeRegistry']>;
    owner: ReturnType<typeof createDaemonPluginRuntimeOwner>;
    controller: ReturnType<typeof createPluginReloadController>;
}>;

async function withInstalledBackgroundService(run: (fixture: InstalledBackgroundService) => Promise<void>, sourceFixtureRoot = fixtureRoot): Promise<void> {
        const root = await mkdtemp(join(tmpdir(), 'happier-packed-background-install-'));
        const happyHomeDir = join(root, 'home');
        await mkdir(happyHomeDir);
        process.stdout.write(`BACKGROUND_SERVICE_EXTERNAL_CONTEXT ${JSON.stringify({ host: hostname(), root, daemonPid: process.pid })}\n`);
        const environment = createEnvKeyScope([
            'HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', 'HAPPIER_CLI_SUBPROCESS_PREFER_TSX',
            'HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK',
        ]);
        environment.patch({
            HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined,
            HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1',
            HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
        });
        const controller = createPluginReloadController({
            happyHomeDir,
            resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
                contributes: createResolvedContributionRegistry({}),
            }),
        });
        // Only the authenticated HTTP boundary is a fixture. Removal still uses
        // the real bound preflight publisher, schema decoder and change owner.
        const preflightHost = fastify({ logger: false });
        const preflightToken = 'packed-background-preflight-test-token';
        const preflightHomeId = 'packed-background-preflight-test-home';
        const preflightController = { machineId: 'packed-background-test-machine', installationId: 'packed-background-test-installation' };
        preflightHost.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async (request, reply) => {
            if (request.headers.authorization !== `Bearer ${preflightToken}`) return reply.code(401).send();
            const input = PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body);
            expect(input).toMatchObject({ pluginId: 'acme.packed-background-service', includeManagedResources: true,
                homeId: preflightHomeId, controller: preflightController });
            return PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 0,
                hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
                managedResources: [], managedResourcesReviewed: true });
        });
        const preflightServerUrl = await preflightHost.listen({ host: '127.0.0.1', port: 0 });
        const owner = createDaemonPluginRuntimeOwner({
            happyHomeDir,
            staleCandidateCleanup: 'disabled',
            reloadController: controller,
            connectedAccounts: createPackedTestConnectedAccountsRuntime({
                happyHomeDir, pluginId: 'acme.packed-background-service',
            }).owner,
            managedResourcePreflight: {
                credentials: { token: preflightToken, encryption: null }, serverUrl: preflightServerUrl,
                homeId: preflightHomeId, controller: preflightController,
            },
        });
        try {
            expect(buildHappyCliSubprocessLaunchSpec(['daemon', 'background-service-worker']).args)
                .toContain(join(projectPath(), 'src', 'index.ts'));
            const initial = await controller.acquireRuntimeRegistry();
            await initial.release();
            const packed = await packLocalPlugin({ locator: sourceFixtureRoot, outPath: join(root, 'fixture.tgz') });
            expect(packed, JSON.stringify(packed)).toMatchObject({ ok: true });
            if (!packed.ok) throw new Error('Packed background fixture failed to pack');
            const requested = await owner.changeService.requestPluginChange({
                kind: 'installArchive', locator: packed.archivePath, expectedIntegrity: packed.archiveIntegrity,
            });
            expect(requested, JSON.stringify(requested)).toMatchObject({ kind: 'reviewRequired', reviewKind: 'installation' });
            if (requested.kind !== 'reviewRequired') throw new Error('Expected install review');
            const installed = await owner.changeService.decidePluginChange({
                pendingChangeId: requested.pendingChangeId, decision: 'installAndTrust', optionalSelections: [],
            });
            expect(installed, JSON.stringify(installed)).toMatchObject({ kind: 'committed', pluginId: 'acme.packed-background-service' });
            const registry = controller.getState().activeRegistry;
            if (!registry) throw new Error('Installed plugin has no serving runtime');
            await run({ registry, owner, controller });
        } finally {
            let shutdownComplete = false;
            try {
                await owner.changeService.shutdown();
                await controller.shutdown();
                shutdownComplete = true;
            } finally {
                await preflightHost.close();
                environment.restore();
                await rm(root, { recursive: true, force: true });
                process.stdout.write(`BACKGROUND_SERVICE_EXTERNAL_CLEANUP ${JSON.stringify({ host: hostname(), root, shutdownComplete, rootRemoved: true })}\n`);
            }
        }
}

describe('packed external process background service', () => {
    it.skipIf(process.platform !== 'linux')('retains admitted Exec descendants through a worker crash while individual cancellation preserves its sibling', async () => {
        const custodyFixture = fileURLToPath(new URL('../testkit/fixtures/packed-background-service-custody', import.meta.url));
        let heldTarget: Readonly<{ pid: number; start: ProcessStartIdentity }> | undefined;
        try {
            await withInstalledBackgroundService(async ({ registry }) => {
                const invoke = (localId: string) => executeContributedAction({
                    runtimeRegistry: registry, actionId: `acme.packed-background-service/${localId}`,
                    input: {}, context: { surface: 'cli' },
                });
                const started = await invoke('start-held');
                expect(started, JSON.stringify(started)).toMatchObject({ matched: true, result: { ok: true } });
                if (!started.matched || !started.result.ok) throw new Error('Native custody runner did not start');
                const observation = started.result.result as Readonly<{ workerPid: number }>;
                process.stdout.write(`BACKGROUND_SERVICE_CUSTODY_PROOF ${JSON.stringify({ phase: 'runner-ready', ...observation })}\n`);
                const tree = await readProcessCensus({ freshness: 'fresh', fields: [] });
                if (tree.status !== 'ok') throw new Error('Native custody identity census is unavailable');
                const candidates = tree.rows.filter(row => row.ppid === observation.workerPid && row.name === 'tail');
                const before = await readProcessCensus({ freshness: 'fresh', pids: [observation.workerPid, ...candidates.map(row => row.pid)], fields: ['argv', 'ownershipEnvironment'] });
                expect(before.status).toBe('ok');
                if (before.status !== 'ok') throw new Error('Native custody census is unavailable');
                const cancelled = before.rows.find(row => row.argv?.some(arg => arg.endsWith('/first.txt')));
                const native = before.rows.find(row => row.argv?.some(arg => arg.endsWith('/second.txt')));
                const worker = before.rows.find(row => row.pid === observation.workerPid);
                if (!cancelled || !native || !worker) throw new Error('Native custody process disappeared before crash: ' + JSON.stringify(before));
                expect(parseProcessOwnerTag(native.ownerTag)?.owner.kind).toBe('service');
                expect(native.ownerTag).toBe(worker.ownerTag);
                expect(cancelled.ownerTag).toBe(worker.ownerTag);
                heldTarget = { pid: native.pid, start: native.start };
                process.stdout.write(`BACKGROUND_SERVICE_CUSTODY_PROOF ${JSON.stringify({ phase: 'native-started', worker, cancelled, native })}\n`);
                await expect(invoke('cancel-one')).resolves.toMatchObject({ matched: true, result: { ok: true } });
                expect(await waitForProcessExit(cancelled.pid)).toBe(true);
                expect(() => process.kill(worker.pid, 0)).not.toThrow();
                expect(() => process.kill(native.pid, 0)).not.toThrow();
                process.stdout.write(`BACKGROUND_SERVICE_CUSTODY_PROOF ${JSON.stringify({ phase: 'one-cancelled', workerPid: worker.pid, siblingPid: native.pid })}\n`);

                const pending = invoke('wait-held');
                await vi.waitFor(async () => {
                    expect(await invoke('probe-state')).toMatchObject({ matched: true, result: { ok: true, result: { waitHeldDemanded: true } } });
                });
                const crash = await terminateProcessTree({ targets: [{ pid: worker.pid, start: worker.start }], tree: false, policy: 'kill' });
                expect(crash.status).toBe('complete');
                process.stdout.write(`BACKGROUND_SERVICE_CUSTODY_PROOF ${JSON.stringify({ phase: 'worker-crashed', crash })}\n`);
                expect(await pending).toMatchObject({ matched: true, result: { ok: false, errorCode: 'background_service_process_exited' } });
                const after = await readProcessCensus({ freshness: 'fresh', pids: [native.pid], fields: [] });
                expect(after.status).toBe('ok');
                if (after.status === 'ok') expect(after.rows.find(row => row.pid === native.pid)?.state ?? 'gone', JSON.stringify({ before, after })).toMatch(/zombie|gone/);
            }, custodyFixture);
        } finally {
            // On RED, the deliberately crashed worker cannot release its escaped native child.
            if (heldTarget) {
                const cleanup = await terminateProcessTree({ targets: [heldTarget], tree: true, rootKind: 'service', policy: 'kill' });
                expect(cleanup.status).toBe('complete');
            }
        }
    }, 360_000);

    it('settles finite children and starts a new child for the next demand', async () => {
        await withInstalledBackgroundService(async ({ registry }) => {
            const invocation = await executeContributedAction({
                runtimeRegistry: registry, actionId: 'acme.packed-background-service/verify', input: { runs: 2 },
                context: { surface: 'cli' },
            });
            expect(invocation, JSON.stringify(invocation)).toMatchObject({ matched: true, result: { ok: true, result: {
                completedRuns: 2,
                services: {
                    storage: { status: 'available' }, settings: { status: 'available' }, events: { status: 'available' },
                    actions: { status: 'unavailable', code: 'plugin_service_unavailable' },
                },
            } } });
            if (!invocation.matched || !invocation.result.ok) throw new Error('Process demand Action failed');
            process.stdout.write(`BACKGROUND_SERVICE_EXTERNAL_PROOF ${JSON.stringify({
                journey: 'finite-settle-new-birth', observation: invocation.result.result,
            })}\n`);
        });
    }, 360_000);

    it('keeps a demanded child alive after its Action returns and joins its retirement during uninstall', async () => {
        await withInstalledBackgroundService(async ({ registry, owner, controller }) => {
            const invocation = await executeContributedAction({
                runtimeRegistry: registry, actionId: 'acme.packed-background-service/start-held', input: {},
                context: { surface: 'cli' },
            });
            expect(invocation, JSON.stringify(invocation)).toMatchObject({ matched: true, result: { ok: true } });
            if (!invocation.matched || !invocation.result.ok) throw new Error('Held process demand Action failed');
            const observation = invocation.result.result as Readonly<{ heldPid: number }>;
            expect(() => process.kill(observation.heldPid, 0)).not.toThrow();
            const beforeUninstall = await readProcessCensus({ freshness: 'fresh', pids: [observation.heldPid], fields: ['ownershipEnvironment'] });
            expect(beforeUninstall.status).toBe('ok');
            if (beforeUninstall.status !== 'ok') throw new Error('Held child census is unavailable');
            const child = beforeUninstall.rows.find(row => row.pid === observation.heldPid);
            expect(parseProcessOwnerTag(child?.ownerTag)?.owner.kind).toBe('service');
            process.stdout.write(`BACKGROUND_SERVICE_EXTERNAL_CHILD ${JSON.stringify({ host: hostname(), journey: 'installed-uninstall',
                pid: child?.pid, start: child?.start, ownerTag: child?.ownerTag })}\n`);
            const uninstalled = await owner.changeService.requestPluginChange({
                kind: 'uninstall', pluginId: 'acme.packed-background-service',
            });
            expect(uninstalled, JSON.stringify(uninstalled)).toMatchObject({ kind: 'committed', desiredGeneration: null, appliedGeneration: null });
            expect(() => process.kill(observation.heldPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
            await expect(executeContributedAction({
                runtimeRegistry: controller.getState().activeRegistry!,
                actionId: 'acme.packed-background-service/verify', input: {}, context: { surface: 'cli' },
            })).resolves.toMatchObject({ matched: false });
            process.stdout.write(`BACKGROUND_SERVICE_EXTERNAL_PROOF ${JSON.stringify({
                journey: 'installed-uninstall', observation: invocation.result.result,
                heldAliveAfterAction: true, heldAbsentAfterUninstall: true,
            })}\n`);
        });
    }, 360_000);

    it('shows the admitted child birth in census and reports a physical crash to pending demand', async () => {
        await withInstalledBackgroundService(async ({ registry }) => {
            const invoke = (localId: string) => executeContributedAction({
                runtimeRegistry: registry, actionId: `acme.packed-background-service/${localId}`,
                input: {}, context: { surface: 'cli' },
            });
            const verified = await invoke('start-held');
            expect(verified, JSON.stringify(verified)).toMatchObject({ matched: true, result: { ok: true } });
            if (!verified.matched || !verified.result.ok) throw new Error('Process demand Action failed');
            const { heldPid } = verified.result.result as Readonly<{ heldPid: number }>;
            const census = await readProcessCensus({ freshness: 'fresh', pids: [heldPid], fields: ['ownershipEnvironment'] });
            expect(census.status).toBe('ok');
            if (census.status !== 'ok') throw new Error('Child census is unavailable');
            const child = census.rows.find(row => row.pid === heldPid);
            expect(child?.pid).not.toBe(process.pid);
            expect(child?.start.startTimeMs).toBeGreaterThan(0);
            expect(parseProcessOwnerTag(child?.ownerTag)?.owner.kind).toBe('service');
            if (!child) throw new Error('Held child is absent from census');
            process.stdout.write(`BACKGROUND_SERVICE_EXTERNAL_CHILD ${JSON.stringify({ host: hostname(), journey: 'physical-crash',
                pid: child.pid, start: child.start, ownerTag: child.ownerTag })}\n`);

            const pending = invoke('wait-held');
            // The marker is written after selecting the original active demand.
            // A new demand here would queue a follow-up, not observe the crash.
            await vi.waitFor(async () => {
                expect(await invoke('probe-state')).toMatchObject({
                    matched: true, result: { ok: true, result: { waitHeldDemanded: true } },
                });
            });
            const crash = await terminateProcessTree({ targets: [{ pid: heldPid, start: child.start }], tree: false, policy: 'kill' });
            expect(crash.status).toBe('complete');
            expect(await pending).toMatchObject({
                matched: true, result: { ok: false, errorCode: 'background_service_process_exited' },
            });
            const after = await readProcessCensus({ freshness: 'fresh', pids: [heldPid], fields: [] });
            expect(after.status).toBe('ok');
            if (after.status === 'ok') expect(after.rows.find(row => row.pid === heldPid)?.state ?? 'gone').toMatch(/zombie|gone/);
            process.stdout.write(`BACKGROUND_SERVICE_EXTERNAL_PROOF ${JSON.stringify({
                journey: 'physical-crash', pid: heldPid, start: child?.start, ownerTag: child?.ownerTag,
                pendingDemandErrorCode: 'background_service_process_exited',
            })}\n`);
        });
    }, 360_000);

    it('keeps installed process demand working through daemon restart and uninstall/re-add', async () => {
        const result = await runPackedPluginTest({
            projectRoot: fixtureRoot,
            connectedAccountPurposeRemovalReaddActionLocalId: 'verify',
        });
        expect(result, JSON.stringify(result)).toMatchObject({
            ok: true,
            pluginId: 'acme.packed-background-service',
            initialInvocation: { result: { completedRuns: 1, previousChildPid: null, previousChildProcessAbsent: true } },
            invocation: { result: { completedRuns: 1, previousChildProcessAbsent: true } },
            publicationRemovalReadd: {
                removed: true,
                readded: true,
                invocation: { result: { completedRuns: 1, previousChildProcessAbsent: true } },
            },
            daemon: { authenticatedControl: true, staleIncarnationRejected: true },
        });
        if (!result.ok) throw new Error('Packed process service journey failed');
        const initial = result.initialInvocation?.result as Readonly<{ childPids: readonly number[] }>;
        const restarted = result.invocation?.result as Readonly<{ childPids: readonly number[]; previousChildPid: number }>;
        const readded = result.publicationRemovalReadd?.invocation.result as Readonly<{ previousChildPid: number }>;
        expect(restarted.previousChildPid).toBe(initial.childPids[0]);
        expect(readded.previousChildPid).toBe(restarted.childPids[0]);
        process.stdout.write(`BACKGROUND_SERVICE_EXTERNAL_PROOF ${JSON.stringify({
            journey: 'packed-restart-uninstall-readd', daemon: result.daemon,
            initial: result.initialInvocation?.result, restarted: result.invocation?.result,
            readded: result.publicationRemovalReadd?.invocation.result,
        })}\n`);
    }, 360_000);
});
