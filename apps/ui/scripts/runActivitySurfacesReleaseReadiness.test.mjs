import test from 'node:test';
import assert from 'node:assert/strict';

import { runActivitySurfacesReleaseReadiness } from './runActivitySurfacesReleaseReadiness.mjs';

test('runActivitySurfacesReleaseReadiness runs rollout-local certification before the full apps/ui typecheck', () => {
    const recordedCalls = [];

    const report = runActivitySurfacesReleaseReadiness({
        env: { npm_execpath: '/native/pnpm' },
        cwd: '/tmp/happier-ui',
        runRolloutCertification({ cwd, env, spawnSyncImpl }) {
            spawnSyncImpl('/native/pnpm', ['--silent', 'run', 'certify:activity-surfaces'], {
                cwd,
                env,
                stdio: 'inherit',
            });
        },
        spawnSyncImpl(command, args, options) {
            recordedCalls.push({ command, args, options });
            return {
                status: 0,
                error: undefined,
            };
        },
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
                args: ['--silent', 'run', 'typecheck'],
                cwd: '/tmp/happier-ui',
            },
        ],
    );

    assert.deepEqual(report, {
        lane: 'release_readiness',
        includedChecks: [
            'certify:activity-surfaces',
            'apps/ui typecheck',
        ],
        excludedChecks: [
            'test:native-e2e:activity-surfaces',
            'validate:ios:widgets:native-sync',
            'validate:ios:widgets:generated-project',
            'validate:ios:widgets:simulator-build-smoke',
            'cargo_check',
            'cargo_test_activity_overlay',
            'live_manual_qa',
        ],
    });
});
