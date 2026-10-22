import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs';

import {
    ACTIVITY_SURFACES_ROLLOUT_LOCAL_EXCLUDED_CHECKS,
    formatActivitySurfacesManualQaScopeNote,
    runActivitySurfacesCertification,
} from './runActivitySurfacesCertification.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = dirname(scriptPath);
const packageRoot = dirname(scriptsDir);

function runStep(command, args, { cwd = packageRoot, env = process.env, spawnSyncImpl = spawnSync } = {}) {
    const invocation = resolvePnpmCommandInvocation(args, { npmExecPath: env.npm_execpath });
    const result = spawnSyncImpl(invocation.command, invocation.args, {
        cwd,
        env,
        stdio: 'inherit',
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`Command failed with exit code ${result.status}: ${[command, ...args].join(' ')}`);
    }
}

export function runActivitySurfacesReleaseReadiness({
    cwd = packageRoot,
    env = process.env,
    spawnSyncImpl = spawnSync,
    runRolloutCertification = runActivitySurfacesCertification,
} = {}) {
    runRolloutCertification({
        cwd,
        env,
        spawnSyncImpl,
    });

    runStep('pnpm', ['--silent', 'run', 'typecheck'], {
        cwd,
        env,
        spawnSyncImpl,
    });

    return {
        lane: 'release_readiness',
        includedChecks: [
            'certify:activity-surfaces',
            'apps/ui typecheck',
        ],
        excludedChecks: ACTIVITY_SURFACES_ROLLOUT_LOCAL_EXCLUDED_CHECKS.filter((entry) =>
            !['apps/ui typecheck'].includes(entry),
        ),
    };
}

function runCli() {
    try {
        const report = runActivitySurfacesReleaseReadiness();
        console.log(
            [
                'Activity-surfaces release-readiness lane passed.',
                formatActivitySurfacesManualQaScopeNote(report),
                `included=${report.includedChecks.join(',')}`,
                `excluded=${report.excludedChecks.join(',')}`,
            ].join(' '),
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

if (process.argv[1] === scriptPath) {
    runCli();
}
