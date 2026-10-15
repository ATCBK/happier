import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { DaemonState } from '@/api/types';

const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
]);

describe('cleanupAndShutdown', () => {
    afterEach(() => {
        envScope.restore();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('drains admitted work before stopping background loops or data transport', async () => {
        await withTempDir('happier-cleanup-shutdown-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });
            vi.resetModules();

            const { cleanupAndShutdown } = await import('./cleanupAndShutdown');
            const calls: string[] = [];
            const beforeShutdown = vi.fn(async () => {
                calls.push('beforeShutdown');
            });
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
                calls.push(`exit:${code ?? ''}`);
                return undefined as never;
            }) as typeof process.exit);

            const params: Parameters<typeof cleanupAndShutdown>[0] & {
                beforeShutdown: () => Promise<void>;
            } = {
                source: 'happier-cli',
                processEnv: {},
                resolvePositiveIntEnv: (_raw, fallback) => fallback,
                restartOnStaleVersionAndHeartbeat: null,
                connectedServiceRefreshLoopHandle: {
                    stop: () => {
                        calls.push('refreshLoopStop');
                    },
                },
                connectedServiceQuotasLoopHandle: {
                    stop: async () => {
                        calls.push('quotaLoopStop');
                        await Promise.resolve();
                        calls.push('quotaLoopStopDone');
                    },
                    pause: () => {},
                    resume: () => {},
                    wake: () => {},
                    subscribeAfterTick: () => () => {},
                },
                apiMachine: null,
                machineConnectionStateCleanup: null,
                automationWorker: null,
                memoryWorker: null,
                voiceInferenceWorker: null,
                trackedSessionCount: 0,
                stopDirectPeerServer: async () => {
                    calls.push('directPeerStop');
                },
                stopTailscaleTransferServeLifecycle: async () => {
                    calls.push('tailscaleStop');
                },
                stopSshTunnelsOnShutdown: async () => {
                    calls.push('sshTunnelsStop');
                },
                stopControlServer: async () => {
                    calls.push('controlServerStop');
                },
                stopKeepAwake: async () => {
                    calls.push('keepAwakeStop');
                },
                daemonLockHandle: null,
                releaseDaemonLock: async () => {
                    calls.push('daemonLockRelease');
                },
                beforeShutdown,
            };

            await cleanupAndShutdown(params);

            expect(beforeShutdown).toHaveBeenCalledTimes(1);
            expect(calls).toEqual([
                'beforeShutdown',
                'refreshLoopStop',
                'quotaLoopStop',
                'quotaLoopStopDone',
                'directPeerStop',
                'tailscaleStop',
                'sshTunnelsStop',
                'controlServerStop',
                'keepAwakeStop',
                'exit:0',
            ]);
            exitSpy.mockRestore();
        });
    });

    it('stops transfer listeners before shutting down the machine-state publisher', async () => {
        await withTempDir('happier-cleanup-transfer-state-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });
            vi.resetModules();

            const { cleanupAndShutdown } = await import('./cleanupAndShutdown');
            const calls: string[] = [];
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
                calls.push(`exit:${code ?? ''}`);
                return undefined as never;
            }) as typeof process.exit);

            await cleanupAndShutdown({
                source: 'happier-cli',
                processEnv: {},
                resolvePositiveIntEnv: (_raw, fallback) => fallback,
                restartOnStaleVersionAndHeartbeat: null,
                connectedServiceRefreshLoopHandle: null,
                connectedServiceQuotasLoopHandle: null,
                apiMachine: {
                    updateDaemonState: async (updater: (state: DaemonState | null) => DaemonState) => {
                        calls.push('shutdownStatePublish');
                        updater(null);
                    },
                    shutdown: async () => {
                        calls.push('apiMachineShutdown');
                    },
                } as never,
                machineConnectionStateCleanup: null,
                automationWorker: null,
                memoryWorker: null,
                voiceInferenceWorker: null,
                trackedSessionCount: 0,
                stopDirectPeerServer: async () => {
                    calls.push('directPeerStop');
                },
                stopTailscaleTransferServeLifecycle: async () => {
                    calls.push('tailscaleStop');
                },
                stopControlServer: async () => {},
                stopKeepAwake: async () => {},
                daemonLockHandle: null,
                releaseDaemonLock: async () => {},
            });

            expect(calls).toEqual([
                'directPeerStop',
                'tailscaleStop',
                'shutdownStatePublish',
                'apiMachineShutdown',
                'exit:0',
            ]);
            exitSpy.mockRestore();
        });
    });

    it('preserves its daemon publication through slow cleanup until lifecycle lock release', async () => {
        await withTempDir('happier-cleanup-live-publication-', async (homeDir) => {
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: 'cloud' });
            vi.resetModules();

            const [{ configuration }, { cleanupAndShutdown }, {
                acquireDaemonLock, readDaemonState, releaseDaemonLock, writeDaemonStateForLockOwner,
            }] = await Promise.all([
                import('@/configuration'),
                import('./cleanupAndShutdown'),
                import('@/persistence'),
            ]);
            const lockHandle = await acquireDaemonLock(2, 1);
            expect(lockHandle).not.toBeNull();
            if (!lockHandle) throw new Error('Daemon lifecycle lock was not acquired');
            const stateOwner = {
                pid: process.pid, httpPort: 5111, startedAt: 1_111,
                startedWithCliVersion: '0.0.0-test', controlToken: 'control-owner',
            };
            expect(writeDaemonStateForLockOwner(lockHandle, stateOwner)).toBe(true);
            const controlStopStarted = createDeferred();
            const releaseControlStop = createDeferred();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
            const shutdown = cleanupAndShutdown({
                source: 'happier-cli', processEnv: {}, resolvePositiveIntEnv: (_raw, fallback) => fallback,
                restartOnStaleVersionAndHeartbeat: null, connectedServiceRefreshLoopHandle: null,
                connectedServiceQuotasLoopHandle: null, apiMachine: null, machineConnectionStateCleanup: null,
                automationWorker: null, memoryWorker: null, voiceInferenceWorker: null, trackedSessionCount: 0,
                stopDirectPeerServer: async () => {}, stopTailscaleTransferServeLifecycle: async () => {},
                // Hold only the control-transport IO boundary; real cleanup,
                // publication ownership and lifecycle lock release stay active.
                stopControlServer: async () => {
                    controlStopStarted.resolve();
                    await releaseControlStop.promise;
                },
                stopKeepAwake: async () => {},
                daemonStateOwner: stateOwner, daemonLockHandle: lockHandle, releaseDaemonLock,
            });
            try {
                await controlStopStarted.promise;
                await expect(readDaemonState()).resolves.toMatchObject(stateOwner);
                expect(existsSync(configuration.daemonLockFile)).toBe(true);
            } finally {
                releaseControlStop.resolve();
                await shutdown;
            }
            await expect(readDaemonState()).resolves.toBeNull();
            expect(existsSync(configuration.daemonLockFile)).toBe(false);
            expect(exitSpy).toHaveBeenCalledWith(0);
        });
    });

    it('does not remove a successor daemon state publication during predecessor shutdown', async () => {
        await withTempDir('happier-cleanup-successor-state-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });
            vi.resetModules();

            const [{ cleanupAndShutdown }, { readDaemonState, writeDaemonState }] = await Promise.all([
                import('./cleanupAndShutdown'),
                import('@/persistence'),
            ]);
            const predecessor = {
                pid: 111,
                httpPort: 5111,
                startedAt: 1_111,
                startedWithCliVersion: '0.0.0-a',
                runtimeId: 'shared-runtime',
                controlToken: 'control-a',
            };
            const successor = {
                pid: 222,
                httpPort: 5222,
                startedAt: 2_222,
                startedWithCliVersion: '0.0.0-b',
                runtimeId: 'shared-runtime',
                controlToken: 'control-b',
            };
            writeDaemonState(successor);
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);

            await cleanupAndShutdown({
                source: 'happier-cli',
                processEnv: {},
                resolvePositiveIntEnv: (_raw, fallback) => fallback,
                restartOnStaleVersionAndHeartbeat: null,
                connectedServiceRefreshLoopHandle: null,
                connectedServiceQuotasLoopHandle: null,
                apiMachine: null,
                machineConnectionStateCleanup: null,
                automationWorker: null,
                memoryWorker: null,
                voiceInferenceWorker: null,
                trackedSessionCount: 0,
                stopDirectPeerServer: async () => {},
                stopTailscaleTransferServeLifecycle: async () => {},
                stopControlServer: async () => {},
                stopKeepAwake: async () => {},
                daemonLockHandle: null,
                releaseDaemonLock: async () => {},
                daemonStateOwner: predecessor,
            });

            await expect(readDaemonState()).resolves.toMatchObject(successor);
            exitSpy.mockRestore();
        });
    });

    it('clears an owned publication before releasing its lifecycle lock after a fatal error', async () => {
        await withTempDir('happier-cleanup-fatal-owner-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });
            vi.resetModules();

            const [
                { configuration },
                { releaseDaemonOwnershipAfterFatal },
                {
                    acquireDaemonLock,
                    readDaemonState,
                    writeDaemonStateForLockOwner,
                },
            ] = await Promise.all([
                import('@/configuration'),
                import('./cleanupAndShutdown'),
                import('@/persistence'),
            ]);
            const lockHandle = await acquireDaemonLock(2, 1);
            expect(lockHandle).not.toBeNull();
            if (!lockHandle) return;

            const stateOwner = {
                pid: process.pid,
                httpPort: 5111,
                startedAt: 1_111,
                startedWithCliVersion: '0.0.0-test',
                controlToken: 'control-owner',
            };
            expect(writeDaemonStateForLockOwner(lockHandle, stateOwner)).toBe(true);

            await releaseDaemonOwnershipAfterFatal({
                daemonLockHandle: lockHandle,
                daemonStateOwner: stateOwner,
            });

            await expect(readDaemonState()).resolves.toBeNull();
            expect(existsSync(configuration.daemonLockFile)).toBe(false);
        });
    });
});
