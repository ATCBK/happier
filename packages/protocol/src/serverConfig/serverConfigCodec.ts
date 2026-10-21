import { parseOptionalBooleanEnv } from '../env/parseBooleanEnv.js';
import type { ServerConfigEntry, ServerConfigEntryInput, ServerConfigJsonValue, ServerConfigValueType } from './serverConfigEntry.js';

/**
 * The one codec between a registry entry and its environment-string form.
 *
 * Readers parse env through `readServerConfig`, the Home settings writer validates through
 * `validateServerConfigValue`, and the env overlay serializes through `serializeServerConfigValue`.
 * Because all three share this module, a value the writer accepted is parsed back by the reader as
 * the same value (plan §2.4 risk 4, "overlay round-trip drift").
 *
 * Env parsing is lenient in the way the server's readers always were (`parseBooleanEnv`,
 * `parseIntEnv`): an unset, unparseable or out-of-bounds value falls back to the entry default.
 * Home writes are strict: the same conditions are refused with a typed reason. `bounds.scheme` is a
 * Home-write bound only: a deployment may point env at a plain-`http` address (a LAN or local
 * development server), but the Home can only persist `https` addresses.
 */
export type ServerConfigEnv = Readonly<Record<string, string | undefined>>;

export type ServerConfigInvalidReason = 'invalid_type' | 'out_of_bounds';

export type ServerConfigParseResult<V> =
    | Readonly<{ kind: 'value'; value: V }>
    | Readonly<{ kind: 'invalid'; reason: ServerConfigInvalidReason }>;

type BaseValueOf<T extends ServerConfigValueType> = T extends 'boolean'
    ? boolean
    : T extends 'int' | 'float'
        ? number
        : T extends 'list'
            ? readonly string[]
            : T extends 'json'
                ? ServerConfigJsonValue
                : string;

export type ServerConfigValueOf<E extends Pick<ServerConfigEntryInput, 'type'>> = E extends {
    type: 'enum'; bounds: { values: readonly (infer V extends string)[] };
} ? V : BaseValueOf<E['type']>;

/** A reader's result: the entry's value type, or `undefined` when the entry declares no default. */
export type ServerConfigReadValue<E extends ServerConfigEntryInput> = E extends { default: infer D }
    ? D extends undefined
        ? ServerConfigValueOf<E> | undefined
        : ServerConfigValueOf<E>
    : ServerConfigValueOf<E> | undefined;

/** The first set raw value among the key and its aliases; presence flags retain whitespace truthiness. */
export function readServerConfigRaw(
    env: ServerConfigEnv,
    entry: Pick<ServerConfigEntry, 'key' | 'aliases' | 'booleanEnvEncoding'>,
): Readonly<{ name: string; raw: string }> | null {
    for (const name of [entry.key, ...(entry.aliases ?? [])]) {
        const raw = env[name];
        if (typeof raw === 'string' && (entry.booleanEnvEncoding === 'presence' ? raw.length > 0 : raw.trim().length > 0)) {
            return { name, raw };
        }
    }
    return null;
}

function canonicalEnumValue(values: readonly string[], raw: string): string | null {
    const lower = raw.trim().toLowerCase();
    return values.find((value) => value.toLowerCase() === lower) ?? null;
}

function checkRange(entry: ServerConfigEntryInput, value: number): ServerConfigInvalidReason | null {
    if (typeof entry.bounds?.min === 'number' && value < entry.bounds.min) return 'out_of_bounds';
    if (typeof entry.bounds?.max === 'number' && value > entry.bounds.max) return 'out_of_bounds';
    return null;
}

type ParseMode = 'env' | 'home';

function checkUrl(entry: ServerConfigEntryInput, raw: string, mode: ParseMode): ServerConfigInvalidReason | null {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return 'invalid_type';
    }
    if (mode === 'home' && entry.bounds?.scheme === 'https' && parsed.protocol !== 'https:') return 'out_of_bounds';
    return null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

function splitList(raw: string): string[] {
    return raw
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function checkListItems(
    entry: ServerConfigEntryInput,
    items: readonly string[],
    mode: ParseMode,
): ServerConfigParseResult<readonly string[]> {
    const values = entry.bounds?.values;
    const out: string[] = [];
    for (const item of items) {
        if (values) {
            const canonical = canonicalEnumValue(values, item);
            if (!canonical) return { kind: 'invalid', reason: 'out_of_bounds' };
            out.push(canonical);
            continue;
        }
        if (entry.bounds?.scheme) {
            const failure = checkUrl(entry, item, mode);
            if (failure) return { kind: 'invalid', reason: failure };
        }
        out.push(item);
    }
    return { kind: 'value', value: Object.freeze(out) };
}

/** Parses one non-blank env string for an entry. */
export function parseServerConfigRaw<E extends ServerConfigEntryInput>(
    entry: E,
    raw: string,
): ServerConfigParseResult<ServerConfigValueOf<E>> {
    return parseWithMode(entry, raw, 'env');
}

function parseWithMode<E extends ServerConfigEntryInput>(
    entry: E,
    raw: string,
    mode: ParseMode,
): ServerConfigParseResult<ServerConfigValueOf<E>> {
    type V = ServerConfigValueOf<E>;
    const trimmed = raw.trim();
    const ok = (value: unknown): ServerConfigParseResult<V> => ({ kind: 'value', value: value as V });
    const invalid = (reason: ServerConfigInvalidReason): ServerConfigParseResult<V> => ({ kind: 'invalid', reason });
    switch (entry.type) {
        case 'boolean': {
            if (mode === 'env' && entry.booleanEnvEncoding === 'presence') return ok(raw.length > 0);
            const parsed = parseOptionalBooleanEnv(trimmed);
            return parsed === null ? invalid('invalid_type') : ok(parsed);
        }
        case 'int': {
            const parsed = Number.parseInt(trimmed, 10);
            if (!Number.isFinite(parsed)) return invalid('invalid_type');
            const failure = checkRange(entry, parsed);
            return failure ? invalid(failure) : ok(parsed);
        }
        case 'float': {
            const parsed = Number.parseFloat(trimmed);
            if (!Number.isFinite(parsed)) return invalid('invalid_type');
            const failure = checkRange(entry, parsed);
            return failure ? invalid(failure) : ok(parsed);
        }
        case 'enum': {
            const normalized = entry.normalizeEnumValue ? entry.normalizeEnumValue(trimmed.toLowerCase()) : trimmed;
            const canonical = normalized === null ? null : canonicalEnumValue(entry.bounds?.values ?? [], normalized);
            return canonical ? ok(canonical) : invalid('out_of_bounds');
        }
        case 'url': {
            const failure = checkUrl(entry, trimmed, mode);
            return failure ? invalid(failure) : ok(trimmed);
        }
        case 'email':
            return EMAIL_PATTERN.test(trimmed) ? ok(trimmed) : invalid('invalid_type');
        case 'list':
            return checkListItems(entry, splitList(trimmed), mode) as ServerConfigParseResult<V>;
        case 'json': {
            try {
                return ok(JSON.parse(trimmed));
            } catch {
                return invalid('invalid_type');
            }
        }
        case 'string': {
            if (entry.bounds?.noControlChars && /\p{Cc}/u.test(trimmed)) return invalid('invalid_type');
            if (entry.bounds?.maxUtf8Bytes !== undefined
                && new TextEncoder().encode(trimmed).byteLength > entry.bounds.maxUtf8Bytes) {
                return invalid('out_of_bounds');
            }
            const normalized = entry.normalizeStringValue ? entry.normalizeStringValue(trimmed) : trimmed;
            return normalized === null ? invalid('invalid_type') : ok(normalized);
        }
    }
}

/**
 * Reads an entry from env the way the server's readers have always read env: the key, then its
 * aliases; blank, unparseable and out-of-bounds values fall back to the declared default.
 */
export function readServerConfig<E extends ServerConfigEntry>(
    env: ServerConfigEnv,
    entry: E,
): ServerConfigReadValue<E> {
    const found = readServerConfigRaw(env, entry);
    if (found) {
        const parsed = parseServerConfigRaw(entry, found.raw);
        if (parsed.kind === 'value') return parsed.value as ServerConfigReadValue<E>;
    }
    return entry.default as ServerConfigReadValue<E>;
}

/** The env-string form the overlay writes for a validated value. */
export function serializeServerConfigValue(entry: ServerConfigEntryInput, value: unknown): string {
    switch (entry.type) {
        case 'boolean':
            if (entry.booleanEnvEncoding === 'presence') return value === true ? 'true' : '';
            return value === true ? 'true' : 'false';
        case 'int':
        case 'float':
            return String(value);
        case 'list':
            return (value as readonly string[]).join(',');
        case 'json':
            return JSON.stringify(value);
        default:
            return String(value);
    }
}

export type ServerConfigValidation<V = unknown> =
    | Readonly<{ ok: true; value: V }>
    | Readonly<{ ok: false; reason: ServerConfigInvalidReason }>;

/** Opens retained typed settings; legacy presence flags were stored as strings, never boolean writes. */
export function readStoredServerConfigValue<E extends ServerConfigEntryInput>(
    entry: E,
    value: unknown,
): ServerConfigValidation<ServerConfigValueOf<E>> {
    if (entry.type === 'boolean' && entry.booleanEnvEncoding === 'presence' && typeof value === 'string') {
        return { ok: true, value: (value.length > 0) as ServerConfigValueOf<E> };
    }
    return validateServerConfigValue(entry, value);
}

function isJsonValue(value: unknown, depth = 0): value is ServerConfigJsonValue {
    if (depth > 32) return false;
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
    if (typeof value === 'object') {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return false;
        return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
    }
    return false;
}

/**
 * Strict validation of a value in env-string form under Home-write bounds. Secrets travel and are
 * stored in this form (a sealed string), so they are validated as text rather than JSON.
 */
export function validateServerConfigText<E extends ServerConfigEntryInput>(
    entry: E,
    raw: string,
): ServerConfigValidation<ServerConfigValueOf<E>> {
    if (!raw.trim()) return { ok: false, reason: 'invalid_type' };
    const parsed = parseWithMode(entry, raw, 'home');
    return parsed.kind === 'value' ? { ok: true, value: parsed.value } : { ok: false, reason: parsed.reason };
}

/**
 * Strict validation of a value a Home owner submits (JSON, not env text). Returns the normalized
 * value, which is what the overlay serializes and what the reader parses back.
 */
export function validateServerConfigValue<E extends ServerConfigEntryInput>(
    entry: E,
    value: unknown,
): ServerConfigValidation<ServerConfigValueOf<E>> {
    type V = ServerConfigValueOf<E>;
    const ok = (normalized: unknown): ServerConfigValidation<V> => ({ ok: true, value: normalized as V });
    const invalid = (reason: ServerConfigInvalidReason): ServerConfigValidation<V> => ({ ok: false, reason });
    switch (entry.type) {
        case 'boolean':
            return typeof value === 'boolean' ? ok(value) : invalid('invalid_type');
        case 'int': {
            if (typeof value !== 'number' || !Number.isSafeInteger(value)) return invalid('invalid_type');
            const failure = checkRange(entry, value);
            return failure ? invalid(failure) : ok(value);
        }
        case 'float': {
            if (typeof value !== 'number' || !Number.isFinite(value)) return invalid('invalid_type');
            const failure = checkRange(entry, value);
            return failure ? invalid(failure) : ok(value);
        }
        case 'list': {
            if (!Array.isArray(value)) return invalid('invalid_type');
            const items: string[] = [];
            for (const item of value) {
                if (typeof item !== 'string') return invalid('invalid_type');
                const trimmed = item.trim();
                // Items are joined with commas in env form, so an item cannot carry a separator.
                if (!trimmed || /[,\n]/.test(trimmed)) return invalid('invalid_type');
                items.push(trimmed);
            }
            const checked = checkListItems(entry, items, 'home');
            return checked.kind === 'value' ? ok(checked.value) : invalid(checked.reason);
        }
        case 'json':
            return isJsonValue(value) ? ok(value) : invalid('invalid_type');
        default: {
            if (typeof value !== 'string' || !value.trim()) return invalid('invalid_type');
            const parsed = parseWithMode(entry, value, 'home');
            return parsed.kind === 'value' ? ok(parsed.value) : invalid(parsed.reason);
        }
    }
}
