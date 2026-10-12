import {
    readServerConfigRaw,
    serializeServerConfigValue,
    validateServerConfigText,
    readStoredServerConfigValue,
    type ServerConfigEnv,
    type ServerConfigInvalidReason,
    type ServerConfigRegistry,
} from '@happier-dev/protocol';

import { SERVER_CONFIG_REGISTRY } from '@/config/serverConfigRegistry';

/**
 * The startup overlay (plan §3.1 "Startup-applied configuration", §3.14 "Restart keys").
 *
 * Right after the database opens, the server reads the stored Home settings once and builds the
 * env its remaining startup composition reads: every stored `apply: 'restart'` value that still
 * validates against its registry entry fills the key when the deployment env leaves it unset. A
 * value that no longer validates (or a sealed secret that cannot be opened) is ignored with a
 * reason, and the server starts on env or the default — a stored setting never stops a start.
 * A value that validates but still prevents a healthy start is recovered by setting the key in
 * the environment, which always wins; the one log line names every Home-applied key for that.
 *
 * Restart values are never applied mid-process: the snapshot is what this process runs with, so
 * the console can say truthfully which stored values are pending until the next start.
 */
export type StoredHomeSettings = Readonly<{
    values: Readonly<Record<string, unknown>>;
    /** Opened secrets by key, in env-string form; `{ unreadable: true }` when the sealing owner cannot open one. */
    secrets: Readonly<Record<string, string | Readonly<{ unreadable: true }>>>;
}>;

export type StartupHomeSettingIgnoredReason = ServerConfigInvalidReason | 'secret_unreadable';

export type StartupHomeEnvSnapshot = Readonly<{
    appliedAt: string;
    /** Restart keys this process took from stored Home settings. */
    applied: readonly string[];
    ignored: Readonly<Record<string, StartupHomeSettingIgnoredReason>>;
}>;

export type StartupHomeEnv = Readonly<{
    /** The environment the deployment gave this process, before any Home value; the lock source. */
    deploymentEnv: ServerConfigEnv;
    /** `deploymentEnv` with the applied restart values filled in. */
    env: ServerConfigEnv;
    snapshot: StartupHomeEnvSnapshot;
}>;

let currentStartupHomeEnv: StartupHomeEnv | null = null;

/** What the running process applied at its start, or `null` before `loadStartupHomeEnv` ran. */
export function readStartupHomeEnv(): StartupHomeEnv | null {
    return currentStartupHomeEnv;
}

export function buildStartupHomeEnv(params: Readonly<{
    env: ServerConfigEnv;
    stored: StoredHomeSettings;
    registry: ServerConfigRegistry;
    now: Date;
}>): StartupHomeEnv {
    const overlay: Record<string, string | undefined> = { ...params.env };
    const applied: string[] = [];
    const ignored: Record<string, StartupHomeSettingIgnoredReason> = {};
    const hasOwn = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

    for (const entry of Object.values(params.registry)) {
        if (entry.editable !== 'home' || entry.apply !== 'restart') continue;
        const source = entry.sensitivity === 'secret' ? params.stored.secrets : params.stored.values;
        if (!hasOwn(source, entry.key)) continue;
        const stored = source[entry.key];
        if (stored === null || stored === undefined) continue;
        if (readServerConfigRaw(params.env, entry)) continue;
        if (typeof stored === 'object' && 'unreadable' in stored) {
            ignored[entry.key] = 'secret_unreadable';
            continue;
        }
        const validated = typeof stored === 'string' && entry.sensitivity === 'secret'
            ? validateServerConfigText(entry, stored)
            : readStoredServerConfigValue(entry, stored);
        if (!validated.ok) {
            ignored[entry.key] = validated.reason;
            continue;
        }
        overlay[entry.key] = serializeServerConfigValue(entry, validated.value);
        applied.push(entry.key);
    }

    return {
        deploymentEnv: params.env,
        env: Object.freeze(overlay),
        snapshot: Object.freeze({ appliedAt: params.now.toISOString(), applied: Object.freeze(applied), ignored: Object.freeze(ignored) }),
    };
}

export function formatStartupHomeEnvLog(snapshot: StartupHomeEnvSnapshot): string {
    const ignored = Object.entries(snapshot.ignored).map(([key, reason]) => `${key} (${reason})`);
    return [
        `Home settings applied at start: ${snapshot.applied.length ? snapshot.applied.join(', ') : 'none'}`,
        ignored.length ? `; ignored: ${ignored.join(', ')}` : '',
        snapshot.applied.length ? '. Set a key in the environment to override a stored value.' : '',
    ].join('');
}

/**
 * The deployment environment explicit values are read from: the snapshot taken at start, before
 * startup composition wrote applied Home values and resolved defaults into `process.env`.
 */
export function readHomeDeploymentEnv(): ServerConfigEnv {
    return currentStartupHomeEnv?.deploymentEnv ?? process.env;
}

/**
 * Hands the applied restart values to the rest of startup composition, whose readers take
 * `process.env`. Only keys the deployment left unset are written (the startup overlay never fills
 * a set key), so an operator's explicit value is never replaced.
 */
export function applyStartupHomeEnvToProcess(startup: StartupHomeEnv, target: NodeJS.ProcessEnv): void {
    for (const key of startup.snapshot.applied) {
        const value = startup.env[key];
        if (value !== undefined) target[key] = value;
    }
}

/**
 * Reads the stored Home settings once, builds the startup overlay, records it for the console,
 * and logs one line. Call it after the database opens and before any `apply: 'restart'` reader.
 */
export async function loadStartupHomeEnv(params: Readonly<{
    env: ServerConfigEnv;
    readStored: () => Promise<StoredHomeSettings>;
    registry?: ServerConfigRegistry;
    log: (line: string) => void;
    now?: () => Date;
}>): Promise<StartupHomeEnv> {
    const startup = buildStartupHomeEnv({
        env: params.env,
        stored: await params.readStored(),
        registry: params.registry ?? SERVER_CONFIG_REGISTRY,
        now: (params.now ?? (() => new Date()))(),
    });
    params.log(formatStartupHomeEnvLog(startup.snapshot));
    currentStartupHomeEnv = startup;
    return startup;
}
