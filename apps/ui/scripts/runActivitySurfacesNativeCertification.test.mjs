import test from 'node:test';
import assert from 'node:assert/strict';

import { runActivitySurfacesNativeCertification } from './runActivitySurfacesNativeCertification.mjs';

test('runActivitySurfacesNativeCertification runs the rollout certification, iOS validation, simulator smoke, and desktop native checks in order', async () => {
    const recordedCalls = [];

    const report = await runActivitySurfacesNativeCertification({
        env: { npm_execpath: '/native/pnpm' },
        cwd: '/tmp/happier-ui',
        runRolloutCertification({ cwd, env, spawnSyncImpl }) {
            spawnSyncImpl('/native/pnpm', ['--silent', 'run', 'certify:activity-surfaces'], {
                cwd,
                env,
                stdio: 'inherit',
            });
        },
        pathExistsImpl: async (path) => path === '/tmp/happier-ui/ios',
        spawnSyncImpl(command, args, options) {
            recordedCalls.push({ command, args, options });
            return {
                status: 0,
                error: undefined,
            };
        },
        log() {},
    });

    assert.deepEqual(
        recordedCalls.map(({ command, args, options }) => ({
            command,
            args,
            cwd: options.cwd,
        })),
        [
            {
                command: '/native/pnpm',
                args: ['--silent', 'run', 'certify:activity-surfaces'],
                cwd: '/tmp/happier-ui',
            },
            {
                command: '/native/pnpm',
                args: ['--silent', 'run', 'validate:ios:widgets:native-sync'],
                cwd: '/tmp/happier-ui',
            },
            {
                command: '/native/pnpm',
                args: ['--silent', 'run', 'validate:ios:widgets:generated-project'],
                cwd: '/tmp/happier-ui',
            },
            {
                command: '/native/pnpm',
                args: ['--silent', 'run', 'validate:ios:widgets:simulator-build-smoke'],
                cwd: '/tmp/happier-ui',
            },
            {
                command: 'cargo',
                args: ['check', '--manifest-path', 'src-tauri/Cargo.toml'],
                cwd: '/tmp/happier-ui',
            },
            {
                command: 'cargo',
                args: ['test', 'activity_overlay', '--lib', '--manifest-path', 'src-tauri/Cargo.toml'],
                cwd: '/tmp/happier-ui',
            },
            {
                command: '/native/pnpm',
                args: ['--silent', 'run', 'test:native-e2e:activity-surfaces'],
                cwd: '/tmp/happier-ui',
            },
        ],
    );

    assert.deepEqual(report, {
        lane: 'native_tightening',
        includedChecks: [
            'certify:activity-surfaces',
            'validate:ios:widgets:native-sync',
            'validate:ios:widgets:generated-project',
            'validate:ios:widgets:simulator-build-smoke',
            'cargo_check',
            'cargo_test_activity_overlay',
            'test:native-e2e:activity-surfaces',
        ],
        excludedChecks: [
            'apps/ui typecheck',
            'live_manual_qa',
        ],
        skippedChecks: [],
    });
});

test('runActivitySurfacesNativeCertification skips generated-project and simulator-smoke validation when ios is absent', async () => {
    const recordedCalls = [];
    const recordedLogs = [];

    const report = await runActivitySurfacesNativeCertification({
        env: { npm_execpath: '/native/pnpm' },
        cwd: '/tmp/happier-ui',
        runRolloutCertification({ cwd, env, spawnSyncImpl }) {
            spawnSyncImpl('/native/pnpm', ['--silent', 'run', 'certify:activity-surfaces'], {
                cwd,
                env,
                stdio: 'inherit',
            });
        },
        pathExistsImpl: async () => false,
        spawnSyncImpl(command, args, options) {
            recordedCalls.push({ command, args, options });
            return {
                status: 0,
                error: undefined,
            };
        },
        log(message) {
            recordedLogs.push(message);
        },
    });

    assert.equal(
        recordedCalls.some(
            ({ command, args }) =>
                command === ('/native/pnpm') &&
                args[0] === '--silent' &&
                ['validate:ios:widgets:generated-project', 'validate:ios:widgets:simulator-build-smoke'].includes(args[2]),
        ),
        false,
    );
    assert.deepEqual(recordedLogs, [
        "Skipping native-only generated iOS widget project and simulator build-smoke validation because 'ios/' is not present. Default certify:activity-surfaces intentionally excludes simulator smoke. Run 'expo prebuild -p ios --no-install' first if you need generated-project or simulator smoke coverage.",
    ]);
    assert.deepEqual(report.skippedChecks, [
        'validate:ios:widgets:generated-project',
        'validate:ios:widgets:simulator-build-smoke',
    ]);
});
