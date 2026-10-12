import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveWindowsCommandOnPath } from '../process/index.js';
import { resolveDirectJavaScriptRuntimeCommand } from './managedJavaScriptRuntime.js';

export type InstalledJavaScriptTool = Readonly<{
    executablePath: string;
    args: readonly string[];
    version?: string;
    environmentOverlay?: Readonly<Record<string, string>>;
}>;

const packages: Readonly<Record<string, readonly string[]>> = {
    npm: ['npm'], yarn: ['yarn', '@yarnpkg/cli-dist'], pnpm: ['pnpm', '@pnpm/exe'],
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Corepack 0.36 installed receipts; read its existing selected package, never invoke the downloader. */
async function readInstalledCorepackEntrypoint(tool: string, processEnv: NodeJS.ProcessEnv, requestedVersion?: string): Promise<Readonly<{ path: string; version?: string }> | null> {
    const home = processEnv.COREPACK_HOME ?? join(processEnv.XDG_CACHE_HOME ?? processEnv.LOCALAPPDATA
        ?? join(homedir(), process.platform === 'win32' ? 'AppData/Local' : '.cache'), 'node/corepack');
    try {
        let reference = requestedVersion;
        if (reference === undefined) {
            const selected: unknown = JSON.parse(await readFile(join(home, 'lastKnownGood.json'), 'utf8'));
            if (!record(selected) || typeof selected[tool] !== 'string') return null;
            reference = selected[tool];
        }
        const version = reference.split('+')[0];
        if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) return null;
        const directory = join(home, 'v1', tool, version);
        const receipt: unknown = JSON.parse(await readFile(join(directory, '.corepack'), 'utf8'));
        if (!record(receipt) || !record(receipt.locator) || receipt.locator.name !== tool
            || typeof receipt.locator.reference !== 'string' || receipt.locator.reference.split('+')[0] !== version) return null;
        if (Array.isArray(receipt.bin)) {
            // Corepack 0.36's single-file Yarn distribution has no package.json.
            // Its completed receipt owns the installed version, not the request.
            if (tool !== 'yarn' || !receipt.bin.every(name => typeof name === 'string') || !receipt.bin.includes(tool)) return null;
            return { path: join(directory, 'yarn.js'), version: receipt.locator.reference.split('+')[0] };
        }
        if (!record(receipt.bin) || typeof receipt.bin[tool] !== 'string') return null;
        const entrypoint = resolve(directory, receipt.bin[tool]);
        const within = relative(directory, entrypoint);
        if (isAbsolute(within) || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return null;
        return { path: entrypoint };
    } catch { return null; }
}

/** Installed metadata only. Never boots a runtime, downloads a manager or invokes a PATH shim. */
export async function resolveInstalledJavaScriptTool(tool: string, processEnv: NodeJS.ProcessEnv = process.env, requestedVersion?: string): Promise<InstalledJavaScriptTool | null> {
    if (tool !== 'node' && !Object.hasOwn(packages, tool)) return null;
    const runtime = resolveDirectJavaScriptRuntimeCommand({ isBunRuntime: false, processEnv });
    if (!runtime || !isAbsolute(runtime) || !/^node(?:\.exe)?$/i.test(basename(runtime))) return null;
    const runtimeVersion = runtime === process.execPath ? process.versions.node : undefined;
    if (tool === 'node') return { executablePath: runtime, args: [], ...(runtimeVersion ? { version: runtimeVersion } : {}) };
    const candidates: { path: string; version?: string }[] = [];
    if (process.platform === 'win32') {
        const command = await resolveWindowsCommandOnPath(tool, processEnv);
        if (command) {
            candidates.push({ path: command });
            // npm's Windows shims are siblings of the installed node_modules.
            for (const name of [...packages[tool], 'corepack']) {
                const packageRoot = join(dirname(command), 'node_modules', name);
                try {
                    const pkg: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
                    if (record(pkg) && record(pkg.bin) && typeof pkg.bin[tool] === 'string') candidates.push({ path: resolve(packageRoot, pkg.bin[tool]) });
                } catch { /* An absent package is not installation authority. */ }
            }
        }
    } else {
        for (const directory of (processEnv.PATH ?? '').split(delimiter).filter(Boolean)) {
            const candidate = join(directory, tool);
            try { await access(candidate, constants.X_OK); candidates.push({ path: candidate }); break; }
            catch { /* Keep the host PATH selection order. */ }
        }
    }
    for (const candidate of candidates) {
        const entrypoint = await realpath(candidate.path).catch(() => null);
        if (!entrypoint || !/\.(?:c?js|mjs)$/i.test(entrypoint)) continue;
        if (candidate.version) return { executablePath: runtime, args: [entrypoint], version: candidate.version,
            environmentOverlay: { PATH: [dirname(runtime), processEnv.PATH ?? ''].filter(Boolean).join(delimiter) } };
        for (let directory = dirname(entrypoint);;) {
            let pkg: unknown;
            try { pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
            catch { pkg = undefined; }
            if (pkg !== undefined) {
                if (!record(pkg) || typeof pkg.name !== 'string' || (!packages[tool].includes(pkg.name) && pkg.name !== 'corepack')
                    || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version)) break;
                const bin = typeof pkg.bin === 'string' ? pkg.bin : record(pkg.bin) ? pkg.bin[tool] : undefined;
                if (typeof bin !== 'string') break;
                const declared = resolve(directory, bin);
                const within = relative(directory, declared);
                if (isAbsolute(within) || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
                    || await realpath(declared).catch(() => null) !== entrypoint) break;
                if (pkg.name === 'corepack') {
                    const installed = await readInstalledCorepackEntrypoint(tool, processEnv, requestedVersion);
                    if (installed) candidates.push(installed);
                    break;
                }
                return { executablePath: runtime, args: [entrypoint], version: pkg.version,
                    environmentOverlay: { PATH: [dirname(runtime), processEnv.PATH ?? ''].filter(Boolean).join(delimiter) } };
            }
            const parent = dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
    }
    return null;
}
