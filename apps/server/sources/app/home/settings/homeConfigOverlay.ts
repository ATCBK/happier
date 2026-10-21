import { readServerConfig, readServerConfigRaw, serializeServerConfigValue, readStoredServerConfigValue, type ServerConfigEnv, type ServerConfigReadValue } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { type ServerConfigApply, type ServerConfigEditable, type ServerConfigEntry, type ServerConfigRegistry, type ServerConfigValue } from '@happier-dev/protocol/serverConfig/serverConfigEntry';
import { type HomeSettingDeclarationV1 } from '@happier-dev/protocol/home/governance';

import { SERVER_CONFIG_REGISTRY } from '@/config/serverConfigRegistry';
import { readServerConfigRuntimeValue, resolveServerConfigRuntimeDefault } from '@/config/serverConfigRuntimeDefaults';

import { stampHomeConfigValues } from './homeConfigProvenance';
import { type StartupHomeEnv, type StartupHomeSettingIgnoredReason } from './startupHomeEnv';

/**
 * The one precedence decision for server configuration (plan §3.1, §3.4, invariant I2):
 *
 *     explicit deployment env → persisted Home setting → effective runtime default
 *
 * An env value that is set (non-blank, under the key or one of its aliases) is a lock: it wins and
 * the console shows it as fixed. A persisted value applies only to `editable: 'home'` entries and
 * only while the entry still accepts it. Readers never learn about Home settings: they keep reading
 * an env-like object, and `buildHomeConfigEnv` fills the unset Home-editable keys of that object
 * with the persisted values in the registry's env form.
 */
export type HomeSettingSource = 'deployment' | 'home' | 'default';

/** Persisted Home setting values keyed by registry env name (secrets are stored separately). */
export type PersistedHomeSettingValues = Readonly<Record<string, unknown>>;

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

export type ResolvedHomeSetting = Readonly<{
    value: ServerConfigValue | null;
    source: HomeSettingSource;
    fixed: boolean;
}>;

function readPersistedValue(entry: ServerConfigEntry, persisted: PersistedHomeSettingValues): ServerConfigValue | undefined {
    if (entry.editable !== 'home' || entry.sensitivity === 'secret') return undefined;
    if (!hasOwn(persisted, entry.key)) return undefined;
    const raw = persisted[entry.key];
    if (raw === null || raw === undefined) return undefined;
    const validated = readStoredServerConfigValue(entry, raw);
    return validated.ok ? validated.value : undefined;
}

function readLivePersistedValue(entry: ServerConfigEntry, env: ServerConfigEnv, persisted: PersistedHomeSettingValues): ServerConfigValue | undefined {
    if (entry.apply !== 'live' || readServerConfigRaw(env, entry)) return undefined;
    return readPersistedValue(entry, persisted);
}

/** The same live precedence as env composition, without copying or enumerating the environment. */
export function readHomeConfigFlag<E extends ServerConfigEntry & { type: 'boolean'; sensitivity: 'plain' }>(
    env: ServerConfigEnv,
    persisted: PersistedHomeSettingValues,
    entry: E,
): ServerConfigReadValue<E> {
    const value = readLivePersistedValue(entry, env, persisted);
    // The shared stored-value codec validated the value against this exact boolean entry.
    return value === undefined ? readServerConfig(env, entry) : value as ServerConfigReadValue<E>;
}

export function resolveHomeSetting(
    entry: ServerConfigEntry,
    env: ServerConfigEnv,
    persisted: PersistedHomeSettingValues,
    runtimeEnv: ServerConfigEnv = env,
): ResolvedHomeSetting {
    const explicit = readServerConfigRaw(env, entry);
    if (explicit) {
        const value = readServerConfigRuntimeValue(entry, runtimeEnv);
        return { value: value ?? null, source: 'deployment', fixed: true };
    }
    const persistedValue = readPersistedValue(entry, persisted);
    if (persistedValue !== undefined) return { value: persistedValue, source: 'home', fixed: false };
    const fallback = readServerConfigRuntimeValue(entry, runtimeEnv);
    return { value: fallback ?? null, source: 'default', fixed: false };
}

/**
 * The env overlay a request or job hands to the unchanged `(env)` readers: `apply: 'live'` keys
 * only, over the startup env (restart keys keep the value this process started with until the next
 * start, see `startupHomeEnv.ts`). Returns `env` itself when no persisted value applies, so a Home
 * with no settings pays nothing.
 */
export function buildHomeConfigEnv(
    env: ServerConfigEnv,
    persisted: PersistedHomeSettingValues,
    registry: ServerConfigRegistry = SERVER_CONFIG_REGISTRY,
    /** Opened secrets in env-text form, keyed by registry name (sealed at rest by `homeSettings.ts`). */
    openedSecrets: Readonly<Record<string, string>> = {},
    /**
     * Values inferred on the hosting computer (the public address, §3.2), in env-text form. They
     * fill a key last — only when neither the deployment nor a persisted Home value sets it — and
     * are stamped `inferred`, so an inferred value never reads as the owner's or the operator's.
     */
    inferred: Readonly<Record<string, string>> = {},
): ServerConfigEnv {
    const filled = new Map<string, Readonly<{ text: string; source: 'home' | 'inferred' }>>();
    for (const [key, text] of Object.entries(openedSecrets)) {
        const entry = hasOwn(registry, key) ? registry[key] : undefined;
        if (!entry || entry.editable !== 'home' || entry.sensitivity !== 'secret' || entry.apply !== 'live') continue;
        if (readServerConfigRaw(env, entry)) continue;
        filled.set(entry.key, { text, source: 'home' });
    }
    for (const key of Object.keys(persisted)) {
        const entry = hasOwn(registry, key) ? registry[key] : undefined;
        if (!entry) continue;
        const value = readLivePersistedValue(entry, env, persisted);
        if (value === undefined) continue;
        filled.set(entry.key, { text: serializeServerConfigValue(entry, value), source: 'home' });
    }
    for (const [key, text] of Object.entries(inferred)) {
        const entry = hasOwn(registry, key) ? registry[key] : undefined;
        if (!entry || entry.apply !== 'live' || !text.trim() || filled.has(key) || readServerConfigRaw(env, entry)) continue;
        filled.set(entry.key, { text, source: 'inferred' });
    }
    if (filled.size === 0) return env;
    const overlay: Record<string, string | undefined> = { ...env };
    const sources: Record<string, 'home' | 'inferred'> = {};
    for (const [key, { text, source }] of filled) {
        overlay[key] = text;
        sources[key] = source;
    }
    stampHomeConfigValues(overlay, sources);
    return Object.freeze(overlay);
}

/**
 * What an overlay was built from, so the governance owner can rebuild it for a prospective
 * authentication policy (`homeAuthenticationPolicyEnv.ts`) instead of reading the stored policy's
 * values as deployment locks. `policyValues` are the env values of the Home authentication policy
 * document (plan §3.4): governance-owned, never stored in `HomeSettings.values`.
 */
export type HomeConfigEnvOrigin = Readonly<{
    base: ServerConfigEnv;
    settingsValues: PersistedHomeSettingValues;
    policyValues: PersistedHomeSettingValues;
    openedSecrets: Readonly<Record<string, string>>;
    /** Values inferred on the hosting computer (§3.2), filled last. */
    inferred?: Readonly<Record<string, string>>;
}>;

const overlayOrigins = new WeakMap<object, HomeConfigEnvOrigin>();

/**
 * Builds the overlay from its origin and remembers the origin for that overlay object. An overlay
 * identical to its base is not registered unless a resolved request/job snapshot was requested.
 * That snapshot keeps the deployment origin even when no Home value applies. `register: false`
 * builds an env the decision owner must treat as a plain deployment env (the console's ceiling).
 */
export function composeHomeConfigEnv(
    origin: HomeConfigEnvOrigin,
    options: Readonly<{ register?: boolean; registry?: ServerConfigRegistry; snapshot?: boolean }> = {},
): ServerConfigEnv {
    let env = buildHomeConfigEnv(
        origin.base,
        { ...origin.settingsValues, ...origin.policyValues },
        options.registry ?? SERVER_CONFIG_REGISTRY,
        origin.openedSecrets,
        origin.inferred ?? {},
    );
    if (env === origin.base) {
        if (!options.snapshot) return env;
        env = Object.freeze({ ...env });
    }
    if (options.register !== false) overlayOrigins.set(env, origin);
    return env;
}

/** The origin of an overlay built by `composeHomeConfigEnv`; `null` for any other env. */
export function readHomeConfigEnvOrigin(env: ServerConfigEnv): HomeConfigEnvOrigin | null {
    return overlayOrigins.get(env) ?? null;
}

export type HomeSettingProjection = Readonly<{
    key: string;
    /** Always `null` for a secret entry: secrets are write-only (invariant I3). */
    value: ServerConfigValue | null;
    source: HomeSettingSource;
    fixed: boolean;
    editable: Exclude<ServerConfigEditable, 'internal'>;
    apply: ServerConfigApply;
    /** Present for `bootstrap` entries: why the console cannot change the key. */
    readOnlyReason?: string;
    /** Present for secret entries only: whether env or the Home has a value. */
    secretSet?: boolean;
    /** The registry facts a client renders the entry from (§3.14 "Console rendering"). */
    declaration: HomeSettingDeclaration;
    /**
     * Present for `apply: 'restart'` entries once the process has started: the value this process
     * runs with (`null` for secrets), whether the effective value differs from it until the next
     * start, and why a stored value was ignored at the last start.
     */
    applied?: Readonly<{
        value: ServerConfigValue | null;
        pending: boolean;
        ignoredReason?: StartupHomeSettingIgnoredReason;
    }>;
}>;

function appliedAtStart(
    entry: ServerConfigEntry,
    startup: StartupHomeEnv,
    current: Readonly<{ value: ServerConfigValue | null; secretSet?: boolean }>,
    persistedRestartSecrets: Readonly<Record<string, string | Readonly<{ unreadable: true }>>>,
    runtimeEnv?: ServerConfigEnv,
): NonNullable<HomeSettingProjection['applied']> {
    const ignoredReason = Object.prototype.hasOwnProperty.call(startup.snapshot.ignored, entry.key)
        ? startup.snapshot.ignored[entry.key]
        : undefined;
    const reason = ignoredReason ? { ignoredReason } : {};
    if (entry.sensitivity === 'secret') {
        const applied = readServerConfigRaw(startup.env, entry)?.raw ?? null;
        const currentSecret = readServerConfigRaw(startup.deploymentEnv, entry)?.raw ?? persistedRestartSecrets[entry.key] ?? null;
        return { value: null, pending: applied !== currentSecret, ...reason };
    }
    const value = runtimeEnv ? readServerConfigRuntimeValue(entry, runtimeEnv) ?? null : resolveHomeSetting(entry, startup.env, {}).value;
    return { value, pending: JSON.stringify(value) !== JSON.stringify(current.value), ...reason };
}

export type HomeSettingDeclaration = HomeSettingDeclarationV1;

/** The wire bounds are a fresh mutable copy: the registry's `values` list is readonly and frozen. */
function declarationBoundsOf(bounds: NonNullable<ServerConfigEntry['bounds']>): NonNullable<HomeSettingDeclaration['bounds']> {
    const { values, ...rest } = bounds;
    return values ? { ...rest, values: [...values] } : { ...rest };
}

/**
 * What a client needs to render an entry: type and bounds for its field and validation, its
 * default, and where it sits. A secret's default is never projected (a secret has none, and the
 * projection must not grow a place for one).
 */
function declarationOf(entry: ServerConfigEntry, fallback: ServerConfigValue | undefined): HomeSettingDeclaration {
    return {
        type: entry.type,
        section: entry.section,
        ...(entry.group !== undefined ? { group: entry.group } : {}),
        ...(entry.appliesWhen !== undefined ? { appliesWhen: { key: entry.appliesWhen.key, values: [...entry.appliesWhen.values] } } : {}),
        ...(entry.family !== undefined ? { family: entry.family } : {}),
        ...(entry.featureId !== undefined ? { featureId: entry.featureId } : {}),
        ...(fallback !== undefined && entry.sensitivity !== 'secret' ? { default: fallback } : {}),
        ...(entry.bounds !== undefined ? { bounds: declarationBoundsOf(entry.bounds) } : {}),
        ...(entry.editable === 'bootstrap' && entry.readOnlyReason !== undefined ? { readOnlyReason: entry.readOnlyReason } : {}),
    };
}

type ProjectedEntry = ServerConfigEntry & Readonly<{ editable: Exclude<ServerConfigEditable, 'internal'> }>;

function isProjectedEntry(entry: ServerConfigEntry): entry is ProjectedEntry {
    return entry.editable !== 'internal';
}

/**
 * The one projection of effective configuration for clients (`home.settings.get`, the Server
 * settings page). Secret entries project presence only, whatever their source. With the startup
 * overlay, restart entries also project what the running process applied.
 */
export function projectHomeSettings(params: Readonly<{
    registry?: ServerConfigRegistry;
    env: ServerConfigEnv;
    /** The running process plus its request-scoped live overlay, not prospective restart values. */
    runtimeEnv?: ServerConfigEnv;
    persisted: PersistedHomeSettingValues;
    persistedSecretKeys: readonly string[];
    /** Opened restart secrets stay private; only their identity comparison is projected. */
    persistedRestartSecrets?: Readonly<Record<string, string | Readonly<{ unreadable: true }>>>;
    startup?: StartupHomeEnv | null;
}>): HomeSettingProjection[] {
    const registry = params.registry ?? SERVER_CONFIG_REGISTRY;
    const persistedSecrets = new Set(params.persistedSecretKeys);
    const runtimeEnv = params.runtimeEnv ?? buildHomeConfigEnv(params.startup?.env ?? params.env, params.persisted, registry);
    // `internal` entries are server-written markers, not settings: never projected (plan §3.14, r4).
    return Object.values(registry).filter(isProjectedEntry).map((entry): HomeSettingProjection => {
        const resolved = entry.sensitivity === 'secret' ? undefined : resolveHomeSetting(entry, params.env, params.persisted, runtimeEnv);
        const fallback = !resolved ? undefined : resolved.source === 'default' ? resolved.value ?? undefined : resolveServerConfigRuntimeDefault(entry, runtimeEnv);
        const base = {
            key: entry.key,
            editable: entry.editable,
            apply: entry.apply,
            declaration: declarationOf(entry, fallback),
            ...(entry.editable === 'bootstrap' && entry.reason ? { readOnlyReason: entry.reason } : {}),
        };
        let row: HomeSettingProjection;
        if (resolved) {
            row = { ...base, ...resolved };
        } else {
            const fixed = readServerConfigRaw(params.env, entry) !== null;
            const homeSet = !fixed && entry.editable === 'home' && persistedSecrets.has(entry.key);
            row = {
                ...base,
                value: null,
                source: fixed ? 'deployment' : homeSet ? 'home' : 'default',
                fixed,
                secretSet: fixed || homeSet,
            };
        }
        if (!params.startup || entry.apply !== 'restart') return row;
        return { ...row, applied: appliedAtStart(entry, params.startup, row, params.persistedRestartSecrets ?? {}, params.runtimeEnv) };
    });
}
