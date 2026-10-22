'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const nodeModulesPathPattern = /(^|[\\/])node_modules([\\/]|$)/i;

function resolvePhysicalWorkingDirectory({ cwd, realpathSync = fs.realpathSync }) {
    try {
        return realpathSync(cwd);
    } catch {
        return cwd;
    }
}

function isInstalledPackageContext({ cwd, realpathSync = fs.realpathSync }) {
    const physicalCwd = resolvePhysicalWorkingDirectory({ cwd, realpathSync });
    return nodeModulesPathPattern.test(physicalCwd);
}

function runUiPostinstall({
    cwd = process.cwd(),
    env = process.env,
    execPath = process.execPath,
    platform = process.platform,
    realpathSync = fs.realpathSync,
    spawnSync = childProcess.spawnSync,
} = {}) {
    if (isInstalledPackageContext({ cwd, realpathSync })) return 0;

    const physicalCwd = resolvePhysicalWorkingDirectory({ cwd, realpathSync });
    const gatePath = path.resolve(physicalCwd, '../../scripts/postinstall/shouldRunPostinstall.cjs');
    try {
        const gate = require(gatePath);
        if (!gate.shouldRunPostinstall({ workspace: 'ui', scope: env.HAPPIER_INSTALL_SCOPE || '' })) return 0;
    } catch {
        // The repository gate is absent when the app package is consumed outside this monorepo.
    }

    if (!fs.existsSync(path.resolve(physicalCwd, 'tools', 'postinstall.mjs'))) return 0;

    const { resolvePnpmCommandInvocation } = require(path.resolve(physicalCwd, '../../scripts/workspaces/execPnpmCommand.mjs'));
    const invocation = resolvePnpmCommandInvocation(['--silent', 'run', 'postinstall:real'], {
        npmExecPath: String(env.npm_execpath ?? ''),
        platform,
        processExecPath: execPath,
        comspec: env.COMSPEC ?? env.ComSpec ?? env.comspec,
    });
    const result = spawnSync(invocation.command, invocation.args, {
        cwd: physicalCwd,
        env,
        stdio: 'inherit',
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    if (result.error) {
        console.error(result.error.message);
        return 1;
    }
    return result.status ?? 1;
}

if (require.main === module) {
    process.exitCode = runUiPostinstall();
}

module.exports = {
    isInstalledPackageContext,
    runUiPostinstall,
};
