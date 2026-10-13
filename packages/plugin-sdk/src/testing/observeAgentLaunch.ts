import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export type ObservedAgentLaunch = Readonly<{
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
    acpSessionNew: unknown | null;
    appServerRequests: readonly Readonly<{ method: string; params: unknown }>[];
    filesWritten: readonly string[];
    runtimeEvents: readonly unknown[];
}>;

/** Record at the genuine process/transport boundary, using the actual launch values. */
export type AgentLaunchObserverBoundaries = Readonly<{
    recordLaunch(input: Readonly<{ argv: readonly string[]; env?: Readonly<Record<string, string | undefined>> }>): void;
    recordAcpSessionNew(params: unknown): void;
    recordAppServerRequest(method: string, params: unknown): void;
    recordRuntimeEvent(event: unknown): void;
    reset(): void;
}>;

function snapshotHome(home: string): Map<string, string> {
    const entries = new Map<string, string>();
    const visit = (path: string): void => {
        const stat = lstatSync(path);
        const mode = stat.mode & 0o777;
        if (stat.isSymbolicLink()) {
            entries.set(path, `link:${mode}:${readlinkSync(path)}`);
        } else if (stat.isDirectory()) {
            entries.set(path, `directory:${mode}`);
            for (const child of readdirSync(path).sort()) visit(join(path, child));
        } else if (stat.isFile()) {
            entries.set(path, `file:${mode}:${stat.mtimeMs}:${stat.ctimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
        } else {
            entries.set(path, `other:${mode}:${stat.size}`);
        }
    };
    if (existsSync(home)) visit(home);
    return entries;
}

export function createAgentLaunchObserver(input: Readonly<{ home: string }>): Readonly<{
    observeLaunch: () => ObservedAgentLaunch;
    boundaries: unknown;
}> {
    let baseline = snapshotHome(input.home);
    let argv: readonly string[] = [];
    let env: Readonly<Record<string, string>> = {};
    let acpSessionNew: unknown | null = null;
    let appServerRequests: Array<Readonly<{ method: string; params: unknown }>> = [];
    let runtimeEvents: unknown[] = [];
    const boundaries: AgentLaunchObserverBoundaries = {
        recordLaunch(launch) {
            argv = [...launch.argv];
            env = Object.fromEntries(Object.entries(launch.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        },
        recordAcpSessionNew(params) { acpSessionNew = structuredClone(params); },
        recordAppServerRequest(method, params) { appServerRequests.push({ method, params: structuredClone(params) }); },
        recordRuntimeEvent(event) { runtimeEvents.push(structuredClone(event)); },
        reset() {
            baseline = snapshotHome(input.home);
            argv = [];
            env = {};
            acpSessionNew = null;
            appServerRequests = [];
            runtimeEvents = [];
        },
    };
    return {
        boundaries,
        observeLaunch() {
            const current = snapshotHome(input.home);
            const filesWritten = [...new Set([...baseline.keys(), ...current.keys()])]
                .filter(path => baseline.get(path) !== current.get(path)).sort();
            return { argv: [...argv], env: { ...env }, acpSessionNew: structuredClone(acpSessionNew),
                appServerRequests: structuredClone(appServerRequests), filesWritten, runtimeEvents: structuredClone(runtimeEvents) };
        },
    };
}
