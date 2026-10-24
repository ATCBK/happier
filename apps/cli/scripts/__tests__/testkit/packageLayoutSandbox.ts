import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createTempDirSync, removeTempDirSync } from '../../../src/testkit/fs/tempDir';
import { ensureDirectorySync } from '../../../src/testkit/fs/fileHelpers';
import { PLUGIN_PACKAGE_PREFIX } from '../../build-owned/bundledPluginMembership.ts';
import { writeSandboxJsonFile, writeSandboxPackage, writeSandboxTextFile } from './cliBinPreflightSandbox';

/** The block-sequence workspace set the dependency-free pnpm reader accepts; fixtures own the layouts these globs select. */
export const FIXTURE_PNPM_WORKSPACE_YAML = 'packages:\n  - apps/*\n  - packages/*\n  - packages/plugins/*\n';

function resolvePackageDir(baseDir: string, packageName: string): string {
    return resolve(baseDir, ...packageName.split('/'));
}

export function createPackageLayoutSandbox(prefix: string): {
    repoRoot: string;
    happyCliDir: string;
    cleanup: () => void;
} {
    const repoRoot = createTempDirSync(prefix);
    const happyCliDir = resolve(repoRoot, 'apps', 'cli');

    ensureDirectorySync(happyCliDir);
    writeSandboxJsonFile(resolve(repoRoot, 'package.json'), { name: 'repo', private: true });
    writeSandboxTextFile(resolve(repoRoot, 'pnpm-lock.yaml'), '# lock\n');
    writeSandboxTextFile(resolve(repoRoot, 'pnpm-workspace.yaml'), FIXTURE_PNPM_WORKSPACE_YAML);

    return {
        repoRoot,
        happyCliDir,
        cleanup() {
            removeTempDirSync(repoRoot);
        },
    };
}

export function writeCliBundledHostPackage(options: {
    happyCliDir: string;
    bundledDependencies?: readonly string[];
    dependencies?: Readonly<Record<string, string>>;
}): void {
    writeSandboxJsonFile(join(options.happyCliDir, 'package.json'), {
        name: '@happier-dev/cli',
        ...(options.bundledDependencies ? { bundledDependencies: [...options.bundledDependencies] } : {}),
        ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    });
}

export function writeWorkspacePackageFixture(options: {
    repoRoot: string;
    workspacePath: string;
    packageName: string;
    manifestOverrides?: Readonly<Record<string, unknown>>;
    files?: Readonly<Record<string, string>>;
}): string {
    const packageDir = resolve(options.repoRoot, options.workspacePath);

    writeSandboxPackage({
        packageDir,
        manifest: {
            name: options.packageName,
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            types: './dist/index.d.ts',
            exports: {
                '.': {
                    default: './dist/index.js',
                    types: './dist/index.d.ts',
                },
            },
            ...(options.manifestOverrides ?? {}),
        },
        files: {
            'dist/index.js': 'export {};\n',
            ...(options.files ?? {}),
        },
    });

    return packageDir;
}

/**
 * Canonical package name for a synthetic `packages/plugins/<pluginId>` workspace.
 * The prefix comes from the membership owner rather than a copied literal, so a
 * fixture can never claim a name that owner would reject.
 */
function bundledPluginPackageName(pluginId: string): string {
    return `${PLUGIN_PACKAGE_PREFIX}${pluginId}`;
}

/**
 * Minimal `src/manifest.ts` body for a synthetic bundled plugin.
 *
 * `readBundledPluginPackageNames` requires this file of every shippable
 * (non-`reservation_only`) `packages/plugins/*` package and fails closed
 * without it, so a synthetic repository that omits it is not a bundled-plugin
 * repository at all: every membership-backed reader — source-artifact
 * inventory verification, publication admission, daemon-readiness stamping —
 * throws before it can observe the behaviour under test.
 */
export function bundledPluginManifestSource(pluginId: string): string {
    return `export const PLUGIN_MANIFEST = Object.freeze({ id: ${JSON.stringify(pluginId)}, runtime: { apiVersion: 1 }, contributes: {} });\n`;
}

/**
 * Writes the source inputs the canonical membership owner requires of a
 * synthetic bundled plugin workspace. Callers that additionally need build
 * outputs, a tsconfig, or a bespoke manifest shape write those themselves;
 * this owns only the membership contract so mtime-ordered fixtures keep
 * control of when their own files land.
 */
export function writeBundledPluginSourceInputs(options: {
    repoRoot: string;
    pluginId: string;
    /** Leave a package.json the caller already wrote with its own exact bytes untouched. */
    writePackageJson?: boolean;
}): string {
    const packageDir = resolve(options.repoRoot, 'packages', 'plugins', options.pluginId);

    if (options.writePackageJson !== false) {
        writeSandboxJsonFile(join(packageDir, 'package.json'), {
            name: bundledPluginPackageName(options.pluginId),
        });
    }
    writeSandboxTextFile(
        join(packageDir, 'src', 'manifest.ts'),
        bundledPluginManifestSource(options.pluginId),
    );

    return packageDir;
}

/** Materializes the build-owned package-correspondence helper in a sandbox. */
export function materializeBundledPluginPackageCorrespondence(options: {
    sourceCliScriptsDir: string;
    targetCliScriptsDir: string;
}): void {
    ensureDirectorySync(resolve(options.targetCliScriptsDir, 'build-owned'));
    for (const relativePath of ['build-owned/bundledPluginPackageCorrespondence.mjs']) {
        cpSync(
            resolve(options.sourceCliScriptsDir, relativePath),
            resolve(options.targetCliScriptsDir, relativePath),
        );
    }
}

export function writeRuntimeDependencyStub(options: {
    repoRoot: string;
    packageName: string;
    manifestOverrides?: Readonly<Record<string, unknown>>;
    files?: Readonly<Record<string, string>>;
}): string {
    const packageDir = resolvePackageDir(resolve(options.repoRoot, 'node_modules'), options.packageName);

    writeSandboxPackage({
        packageDir,
        manifest: {
            name: options.packageName,
            version: '1.0.0',
            main: 'index.js',
            ...(options.manifestOverrides ?? {}),
        },
        files: {
            'index.js': 'module.exports = {};\n',
            ...(options.files ?? {}),
        },
    });

    return packageDir;
}
