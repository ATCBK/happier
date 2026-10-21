import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { spawnDaemonLifecycleOwner } from '@/testkit/process/daemonLifecycleOwner';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { createHappierJsonExecutorFromTextRunner } from '@happier-dev/cli-common/systemTasks';

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('./commandExistsInPath');
    vi.resetModules();
});

it.each([
    { scenario: 'late-owner', platform: 'linux' },
    { scenario: 'late-owner-slow-probe', platform: 'linux' },
    { scenario: 'late-owner', platform: 'darwin' },
    { scenario: 'late-owner', platform: 'win32' },
    { scenario: 'queued-owner', platform: 'win32' },
    { scenario: 'queued-owner', platform: 'darwin' },
    { scenario: 'kickstart-exit', platform: 'darwin' },
    { scenario: 'never-owner', platform: 'linux' },
    { scenario: 'wrong-owner', platform: 'linux' },
    { scenario: 'wrong-owner', platform: 'darwin' },
    { scenario: 'wrong-owner', platform: 'win32' },
    { scenario: 'exited-service', platform: 'linux' },
    { scenario: 'exited-service', platform: 'darwin' },
    { scenario: 'exited-service', platform: 'win32' },
    { scenario: 'crash-loop', platform: 'linux' },
    { scenario: 'crash-loop', platform: 'darwin' },
] as const)(
    'uses the remaining enrollment lifetime for $platform service ownership ($scenario)', async ({ scenario, platform }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-service-enrollment-lifetime-', env: {
            HAPPIER_DAEMON_SERVICE_PLATFORM: platform,
            HAPPIER_DAEMON_SERVICE_NODE_PATH: process.execPath,
            HAPPIER_DAEMON_SERVICE_ENTRY_PATH: join(process.cwd(), 'src/index.ts'),
            HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: undefined,
            HAPPIER_DAEMON_SERVICE_OWNERSHIP_ACTIVE_GRACE_TIMEOUT_MS: undefined,
            HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '100',
            HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '1000',
        } }, async () => {
            const owner = spawnDaemonLifecycleOwner();
            let elapsedMs = 0;
            let serviceStarted = false;
            let publishedOwner = false;
            let slowProbeCharged = false;
            let publishOwner = () => {};
            let retireOwner = () => {};
            let launchdBootstrap = false;
            try {
                vi.resetModules();
                vi.doMock('./commandExistsInPath', () => ({ commandExistsInPath: () => true }));
                // Only the service manager/process boundary is replaced. Service planning,
                // credential persistence and daemon ownership evaluation remain real.
                vi.doMock('node:child_process', async (importOriginal) => ({
                    ...await importOriginal<typeof import('node:child_process')>(),
                    spawnSync: (command: string, args: readonly string[] = []) => {
                        if (command === 'powershell.exe' && args.some(arg => arg.includes('.GetFolder("\\Happier")'))) {
                            return { status: 0, stdout: Buffer.from('[]'), stderr: Buffer.from('') };
                        }
                        if ((command === 'systemctl' && (args.includes('start') || args.includes('restart')))
                            || (command === 'launchctl' && ['bootstrap', 'kickstart'].includes(args[0]!))
                            || (command === 'schtasks' && args[0] === '/Run')) serviceStarted = true;
                        if (command === 'launchctl' && args[0] === 'bootstrap') launchdBootstrap = true;
                        if (['queued-owner', 'kickstart-exit'].includes(scenario) && command === 'launchctl' && args[0] === 'kickstart') retireOwner();
                        if (serviceStarted && !publishedOwner && elapsedMs >= 145_000 && (scenario.startsWith('late-owner') || scenario === 'queued-owner')) {
                            publishOwner();
                            publishedOwner = true;
                        }
                        if (scenario === 'late-owner-slow-probe' && publishedOwner && !slowProbeCharged && elapsedMs >= 146_000) {
                            // The existing structured systemd query can take two seconds.
                            elapsedMs += 2_000;
                            slowProbeCharged = true;
                        }
                        if (serviceStarted && !publishedOwner && elapsedMs >= 2_000 && scenario === 'wrong-owner') {
                            publishOwner();
                            publishedOwner = true;
                        }
                        // Let the pre-fix indefinite Linux wait eventually settle so RED
                        // observes its renewed budget, rather than a runner timeout.
                        const stopped = (['exited-service', 'crash-loop', 'kickstart-exit'].includes(scenario) && elapsedMs >= 2_000)
                            || (scenario === 'never-owner' && elapsedMs >= 481_000);
                        const starting = (scenario.startsWith('late-owner') || scenario === 'queued-owner') && !publishedOwner;
                        let stdout = stopped ? 'failed' : starting ? 'activating' : 'active';
                        if (command === 'systemctl' && args.includes('show')) {
                            stdout = `ActiveState=${stopped ? scenario === 'crash-loop' ? 'activating' : 'failed' : starting ? 'activating' : 'active'}\nSubState=${stopped ? 'auto-restart' : starting ? 'start' : 'running'}\nResult=${stopped ? 'exit-code' : 'success'}\nExecMainStatus=${stopped ? 1 : 0}\nNRestarts=${scenario === 'crash-loop' ? 7 : 0}\n`;
                        }
                        if (command === 'launchctl' && args[0] === 'print') stdout = stopped || (scenario === 'queued-owner' && serviceStarted && !publishedOwner)
                            ? `state = waiting\nruns = ${scenario === 'kickstart-exit' ? 2 : 1}\nlast exit code = 1\n` : 'state = running\nruns = 1\nlast exit code = 1\n';
                        if (command === 'powershell.exe') {
                            const queued = scenario === 'queued-owner' && !publishedOwner;
                            stdout = JSON.stringify({ exists: true, enabled: true,
                                active: !stopped && !queued, stateValue: queued ? elapsedMs < 1_000 ? 3 : 2 : stopped ? 3 : 4,
                                stateLabel: queued ? 'Queued' : stopped ? 'Ready' : 'Running',
                                lastRunTime: new Date(Date.now() - (queued ? 600_000 : 0)).toISOString(), lastTaskResult: stopped ? 1 : 0 });
                        }
                        return { status: args.includes('is-active') && (stopped || starting) ? 3 : 0,
                            stdout: Buffer.from(stdout), stderr: Buffer.from('') };
                    },
                }));
                const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths },
                    { writeCredentialsTokenOnly, writeDaemonState, clearDaemonStateForTestTeardown }, { configuration }, { planDaemonServiceInstall }] = await Promise.all([
                    import('./cli'), import('@/persistence'), import('@/configuration'), import('./plan'),
                ]);
                const runtime = resolveDaemonServiceCliRuntimeFromEnv();
                const paths = resolveDaemonServicePaths(runtime);
                mkdirSync(dirname(paths.installedPath), { recursive: true });
                writeFileSync(paths.installedPath, planDaemonServiceInstall({ ...runtime, mode: 'user', uid: runtime.uid ?? undefined }).files[0]!.content);
                await writeCredentialsTokenOnly({ token: 'enrollment-lifetime-token' });
                publishOwner = () => writeDaemonState({ pid: owner.pid, httpPort: 43124, startedAt: Date.now(),
                    startedWithCliVersion: configuration.currentCliVersion, startupSource: 'background-service',
                    serviceLabel: scenario === 'wrong-owner' ? 'another-service' : paths.label });
                retireOwner = clearDaemonStateForTestTeardown;
                if (['queued-owner', 'kickstart-exit'].includes(scenario) && platform === 'darwin') publishOwner();

                const startedAt = Date.now();
                vi.spyOn(Date, 'now').mockImplementation(() => startedAt + elapsedMs);
                vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
                const realSetTimeout = globalThis.setTimeout;
                // Accelerate the clock boundary without mocking the polling/ownership logic.
                vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
                    realSetTimeout(() => { elapsedMs += Number(delay ?? 0); callback(...args); }, 0));
                const output = captureStdoutJsonOutput<{ ok: boolean }>();
                try {
                    // Keep the real process-output adapter so timeout failures retain the
                    // task's existing cli_command_failed type at the caller boundary.
                    const executor = createHappierJsonExecutorFromTextRunner(async args => {
                        try {
                            await runDaemonServiceCliCommand({ argv: args });
                            return { status: 0, stdout: JSON.stringify(output.json()), stderr: '' };
                        } catch (error) {
                            return { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
                        }
                    });
                    const result = executor.runHappierJson(['start', '--wait-timeout-ms', scenario === 'late-owner-slow-probe' ? '147000' : '480000', '--json']);
                    if (scenario === 'late-owner' || scenario === 'queued-owner') {
                        await expect(result).resolves.toMatchObject({ ok: true });
                        expect(elapsedMs).toBeGreaterThanOrEqual(145_000);
                        expect(elapsedMs).toBeLessThan(480_000);
                    } else {
                        await expect(result).rejects.toMatchObject({ code: 'cli_command_failed' });
                        if (scenario === 'late-owner-slow-probe') expect(elapsedMs).toBeGreaterThanOrEqual(147_000);
                        else if (scenario === 'never-owner') expect(elapsedMs).toBe(480_000);
                        else expect(elapsedMs).toBeLessThan(5_000);
                    }
                    if (['queued-owner', 'kickstart-exit'].includes(scenario) && platform === 'darwin') expect(launchdBootstrap).toBe(false);
                } finally { output.restore(); }
            } finally {
                vi.restoreAllMocks();
                expect(await owner.kill()).toBe(true);
            }
        });
    }, 30_000,
);
