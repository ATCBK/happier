import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createSpawnHappyCliEnvScope, publishPinnedRunnerSnapshotFixture } from '@/testkit/process/spawnHappyCliHarness';
import { routeSpawnModeAndWaitForWebhook } from './routeSpawnModeAndWaitForWebhook';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { persistAcceptedSpawnMarker } from './persistAcceptedSpawnMarker';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { listSessionMarkers } from '../sessionRegistry';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import type { TrackedSession } from '../types';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { reloadConfiguration } from '@/configuration';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { buildSpawnSessionOptionsFromRespawnDescriptorV1 } from '../processSupervision/sessionRunnerRespawnDescriptor';
import { readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot } from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';

const envScope = createSpawnHappyCliEnvScope();
afterEach(() => { envScope.restore(); vi.unstubAllEnvs(); reloadConfiguration(); vi.unstubAllGlobals(); });

it('requires managed runtime bootstrap before admitting a pinned runner through native launch, marker custody and canonical readiness', async () => {
    await withTempDir('happier-route-native-admission-', async root => {
        const stagingRoot = join(root, '.runner-snapshots', '.staging');
        const stagingEntrypoint = join(stagingRoot, 'package-dist', 'index.mjs');
        mkdirSync(dirname(stagingEntrypoint), { recursive: true });
        // The external native receiver consumes its own physical package; this is not a Happier domain replacement.
        const packageNames = ['@happier-dev/route-native-fixture'];
        const nativePackageRoot = join(stagingRoot, 'node_modules', '@happier-dev', 'route-native-fixture');
        mkdirSync(nativePackageRoot, { recursive: true });
        writeFileSync(join(nativePackageRoot, 'package.json'), JSON.stringify({ name: packageNames[0], type: 'module', main: 'index.js' }));
        writeFileSync(join(nativePackageRoot, 'index.js'), 'export const keepAlive = () => setInterval(() => {}, 1000);\n');
        const workspaceRuntime = readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({ runtimeRoot: stagingRoot, packageNames });
        // A genuine child process exposes its received invocation and remains alive until its owning test closes it.
        writeFileSync(stagingEntrypoint, `import { writeFileSync } from 'node:fs';\nimport { keepAlive } from '@happier-dev/route-native-fixture';\nwriteFileSync(process.env.ROUTE_FIXTURE_READY, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));\nkeepAlive();\n`);
        const closure = publishPinnedRunnerSnapshotFixture({
            stagingRoot, workspaceRuntimeIdentity: workspaceRuntime.fingerprint,
            workspaceRuntimePackages: workspaceRuntime.packageNames,
        });
        const runtimeStatePath = join(root, 'stack.runtime.json');
        writeFileSync(runtimeStatePath, JSON.stringify({ version: 1, stackName: 'session-spawn-test', daemon: {} }));
        const homeDir = join(root, 'home');
        const directory = join(root, 'project');
        mkdirSync(directory);
        const readyPath = join(root, 'native-ready.json');
        const originalExecPath = process.execPath;
        envScope.patch({
            HAPPIER_HOME_DIR: homeDir,
            HAPPIER_MANAGED_NODE_BIN: undefined,
            HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined,
            HAPPIER_STACK_REPO_DIR: undefined,
            HAPPIER_STACK_CLI_ROOT_DIR: undefined,
            HAPPIER_STACK_STACK: 'session-spawn-test',
            HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
            HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
            HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
            HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: closure.snapshotEntrypoint,
            HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: closure.fingerprint,
            HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        });
        vi.stubEnv('ROUTE_FIXTURE_READY', readyPath);
        vi.stubEnv('PATH', '');
        reloadConfiguration();
        const runtime = await createAdmittedPluginRuntimeFixture({
            happyHomeDir: homeDir, controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.agent.opencode'] },
        });
        const pidToTrackedSession = new Map<number, TrackedSession>();
        const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
        const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
        const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
        const spawnResourceCleanupByPid = new Map<number, () => void | Promise<void>>();
        const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
        const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(root, 'device-key.json') });
        const lifecycle = createSpawnLifecycleCallbacks({
            connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture',
            hasConnectedServiceAuth: () => false,
            getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {},
            spawnResourceCleanupByPid, getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {},
            sessionAttachCleanupByPid,
            persistAcceptedSpawnMarker: (trackedSession, options) => persistAcceptedSpawnMarker({
                trackedSession, deviceLocalSecretStorage, ...options,
            }),
        });
        const backendTarget = { kind: 'backend' as const, sourceKind: 'built_in' as const, backendId: 'opencode' };
        const spawnOptions = { directory, backendTarget };
        const params = {
            terminalPresentation: { kind: 'runner' as const, startingMode: 'remote' as const },
            terminalRequest: { requested: 'plain' as const },
            directory, options: spawnOptions, trackedSpawnOptions: spawnOptions,
            normalizedExistingSessionId: '', effectiveResume: '',
            effectiveBackendTargetV2: backendTarget,
            directoryCreated: false, extraEnvForChildWithMessage: {}, processEnv: { ...process.env }, happyHomeDir: homeDir,
            pidToTrackedSession, pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout,
            // Plain launch readiness comes from the canonical webhook owner, never a fixture Session resolver.
            resolveCanonicalTrackedSessionId: () => { throw new Error('Plain routing must not consult the terminal-host Session resolver'); },
            onChildExited: () => {}, spawnLifecycleCallbacks: lifecycle, cleanupSpawnResources: () => {},
            onUntrackedHostedChild: () => { throw new Error('Plain routing unexpectedly created a hosted child'); },
            logDebug: () => {}, warn: () => {},
        };
        const offline = new Error('Node release service unavailable');
        vi.stubGlobal('fetch', async () => { throw offline; });
        Object.defineProperty(process, 'execPath', { configurable: true, value: join(root, 'happier') });
        let launching: Promise<SpawnSessionResult> | undefined;
        try {
            await expect(routeSpawnModeAndWaitForWebhook(params)).rejects.toMatchObject({
                message: 'Managed JavaScript runtime is unavailable: bootstrap failed', cause: offline,
            });
            expect(pidToTrackedSession.size).toBe(0);
            await expect(listSessionMarkers()).resolves.toEqual([]);

            const managedRoot = join(homeDir, 'tools', 'js-runtime', 'current');
            const nodePath = process.platform === 'win32' ? join(managedRoot, 'runtime', 'node.exe') : join(managedRoot, 'runtime', 'bin', 'node');
            mkdirSync(dirname(nodePath), { recursive: true });
            if (process.platform === 'win32') copyFileSync(originalExecPath, nodePath);
            else symlinkSync(originalExecPath, nodePath);
            await writeExecutableShim({
                dir: join(managedRoot, 'bin'),
                fileName: process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime',
                contents: process.platform === 'win32'
                    ? `@echo off\r\n"${nodePath}" %*\r\n`
                    : `#!/bin/sh\nexec "${nodePath}" "$@"\n`,
            });
            launching = routeSpawnModeAndWaitForWebhook(params);
            let launchFailure: unknown;
            void launching.catch(error => { launchFailure = error; });
            let native: { pid: number; args: string[] } | undefined;
            await vi.waitFor(() => {
                if (launchFailure) throw launchFailure;
                const parsed: unknown = JSON.parse(readFileSync(readyPath, 'utf8'));
                if (!parsed || typeof parsed !== 'object' || !('pid' in parsed) || typeof parsed.pid !== 'number'
                    || !('args' in parsed) || !Array.isArray(parsed.args) || !parsed.args.every(arg => typeof arg === 'string')) {
                    throw new Error('Invalid native runner receipt');
                }
                native = { pid: parsed.pid, args: parsed.args };
                expect(pidToTrackedSession.has(native.pid)).toBe(true);
            });
            if (!native) throw new Error('Missing native runner receipt');
            const tracked = pidToTrackedSession.get(native.pid)!;
            await tracked.acceptedSpawnMarkerGate;
            expect(native.args).toEqual(['opencode', '--happy-starting-mode', 'remote', '--started-by', 'daemon']);
            const acceptedMarkers = await listSessionMarkers();
            expect(acceptedMarkers).toEqual(expect.arrayContaining([expect.objectContaining({
                pid: native.pid, happySessionId: `PID-${native.pid}`, cwd: directory,
                processStartTimeMs: tracked.processStartTimeMs,
            })]));
            const marker = acceptedMarkers.find(candidate => candidate.pid === native!.pid);
            if (!marker?.respawn) throw new Error('Missing accepted runner recovery custody');
            expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(marker.respawn, { deviceLocalSecretStorage }))
                .toMatchObject({ directory, backendTarget });
            const onWebhook = createOnHappySessionWebhook({
                pidToTrackedSession, pidToAwaiter, spawnResourceCleanupByPid, sessionAttachCleanupByPid,
                deviceLocalSecretStorage,
            });
            await onWebhook('session-native-admission', {
                path: directory, host: 'native-fixture', homeDir: root, happyHomeDir: homeDir,
                happyLibDir: closure.snapshotRoot, happyToolsDir: join(closure.snapshotRoot, 'tools'),
                hostPid: native.pid, startedBy: 'daemon', machineId: 'machine-native-fixture',
            });
            await expect(launching).resolves.toMatchObject({ type: 'success', sessionId: 'session-native-admission' });
            expect(tracked.happySessionId).toBe('session-native-admission');
            // A plain receiver has no Agent-runtime authority gate: its real webhook owner
            // publishes the marker asynchronously and exposes that write's settlement.
            await tracked.reportMarkerCustody?.pending;
            expect(await listSessionMarkers()).toEqual(expect.arrayContaining([expect.objectContaining({
                pid: native.pid, happySessionId: 'session-native-admission',
            })]));
            expect(pidToAwaiter.size).toBe(0);
            expect(pidToSpawnWebhookTimeout.size).toBe(0);
        } finally {
            for (const tracked of pidToTrackedSession.values()) {
                const child = tracked.childProcess;
                if (child && child.exitCode === null) {
                    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
                    child.kill('SIGTERM');
                    await exited;
                }
            }
            for (const timeout of pidToSpawnWebhookTimeout.values()) clearTimeout(timeout);
            await runtime.dispose();
            Object.defineProperty(process, 'execPath', { configurable: true, value: originalExecPath });
        }
    });
});
