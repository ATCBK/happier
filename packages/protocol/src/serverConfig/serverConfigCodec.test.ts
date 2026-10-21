import { describe, expect, it } from 'vitest';

import { parseServerConfigRaw, readServerConfig, serializeServerConfigValue, validateServerConfigValue } from './serverConfigCodec.js';
import { composeServerConfigRegistry, defineServerConfigRegistry } from './serverConfigEntry.js';
import { SERVER_CONFIG, SERVER_CONFIG_REGISTRY_BASE } from './registry.js';

const TEST_CONFIG = defineServerConfigRegistry({
    TEST_FLAG: { type: 'boolean', default: true, sensitivity: 'plain', apply: 'live', editable: 'home', section: 'features', description: 'Flag.' },
    TEST_PORT: {
        type: 'int',
        default: 587,
        bounds: { min: 1, max: 65_535 },
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'email',
        aliases: ['LEGACY_TEST_PORT'],
        description: 'Port.',
    },
    TEST_MODE: {
        type: 'enum',
        bounds: { values: ['automatic', 'disabled'] },
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'reach',
        description: 'Mode.',
    },
    TEST_URLS: {
        type: 'list',
        bounds: { scheme: 'https' },
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'reach',
        description: 'URLs.',
    },
});

describe('readServerConfig', () => {
    it('validates and normalizes the same report contact through deployment and Home configuration', () => {
        const entry = SERVER_CONFIG.HAPPIER_PUBLIC_PROFILE_REPORT_URL;
        expect(readServerConfig({}, entry)).toBeUndefined();
        for (const [raw, normalized] of [
            [' https://reports.example.test/profiles?source=profile ', 'https://reports.example.test/profiles?source=profile'],
            [' MAILTO:operator@example.test?subject=Public%20profile ', 'mailto:operator@example.test?subject=Public%20profile'],
        ]) {
            expect(readServerConfig({ [entry.key]: raw }, entry)).toBe(normalized);
            expect(validateServerConfigValue(entry, raw)).toEqual({ ok: true, value: normalized });
            expect(readServerConfig({ [entry.key]: serializeServerConfigValue(entry, normalized) }, entry)).toBe(normalized);
        }
        for (const raw of ['http://reports.example.test', 'javascript:alert(1)', '/reports', 'not a url',
            'https://user:password@reports.example.test', 'mailto:', 'mailto:operator', 'mailto://operator@example.test',
            'mailto:operator%0A@example.test', 'https://reports.example.test/\nprivate']) {
            expect(readServerConfig({ [entry.key]: raw }, entry), raw).toBeUndefined();
            expect(validateServerConfigValue(entry, raw).ok, raw).toBe(false);
        }
    });

    it('falls back to the declared default when unset, blank, unparseable or out of bounds', () => {
        expect(readServerConfig({}, TEST_CONFIG.TEST_PORT)).toBe(587);
        expect(readServerConfig({ TEST_PORT: '  ' }, TEST_CONFIG.TEST_PORT)).toBe(587);
        expect(readServerConfig({ TEST_PORT: 'abc' }, TEST_CONFIG.TEST_PORT)).toBe(587);
        expect(readServerConfig({ TEST_PORT: '70000' }, TEST_CONFIG.TEST_PORT)).toBe(587);
        expect(readServerConfig({ TEST_FLAG: 'nope' }, TEST_CONFIG.TEST_FLAG)).toBe(true);
    });

    it('reads the key before its aliases, and an alias when the key is unset', () => {
        expect(readServerConfig({ TEST_PORT: '25', LEGACY_TEST_PORT: '2525' }, TEST_CONFIG.TEST_PORT)).toBe(25);
        expect(readServerConfig({ LEGACY_TEST_PORT: '2525' }, TEST_CONFIG.TEST_PORT)).toBe(2525);
    });

    it('canonicalizes enum and list values and rejects values outside their bounds', () => {
        expect(readServerConfig({ TEST_MODE: ' Disabled ' }, TEST_CONFIG.TEST_MODE)).toBe('disabled');
        expect(readServerConfig({ TEST_MODE: 'sometimes' }, TEST_CONFIG.TEST_MODE)).toBeUndefined();
        expect(readServerConfig({ TEST_URLS: 'https://a.example, https://b.example\n' }, TEST_CONFIG.TEST_URLS)).toEqual([
            'https://a.example',
            'https://b.example',
        ]);
        expect(readServerConfig({ TEST_URLS: 'https://a.example,not a url' }, TEST_CONFIG.TEST_URLS)).toBeUndefined();
    });

    it('lets the deployment env use a plain-http address that a Home write could not set', () => {
        expect(readServerConfig({ TEST_URLS: 'http://relay.lan:8080' }, TEST_CONFIG.TEST_URLS)).toEqual(['http://relay.lan:8080']);
    });
});

describe('validateServerConfigValue', () => {
    it('refuses wrong types and out-of-bounds values with a typed reason', () => {
        expect(validateServerConfigValue(TEST_CONFIG.TEST_PORT, '25')).toEqual({ ok: false, reason: 'invalid_type' });
        expect(validateServerConfigValue(TEST_CONFIG.TEST_PORT, 2.5)).toEqual({ ok: false, reason: 'invalid_type' });
        expect(validateServerConfigValue(TEST_CONFIG.TEST_PORT, 0)).toEqual({ ok: false, reason: 'out_of_bounds' });
        expect(validateServerConfigValue(TEST_CONFIG.TEST_FLAG, 'true')).toEqual({ ok: false, reason: 'invalid_type' });
        expect(validateServerConfigValue(TEST_CONFIG.TEST_MODE, 'sometimes')).toEqual({ ok: false, reason: 'out_of_bounds' });
        expect(validateServerConfigValue(TEST_CONFIG.TEST_URLS, ['https://a.example,https://b.example'])).toEqual({
            ok: false,
            reason: 'invalid_type',
        });
        expect(validateServerConfigValue(TEST_CONFIG.TEST_URLS, ['http://a.example'])).toEqual({ ok: false, reason: 'out_of_bounds' });
    });

    it('round-trips every accepted value through the env form the overlay writes', () => {
        const samples = [
            [TEST_CONFIG.TEST_FLAG, false],
            [TEST_CONFIG.TEST_PORT, 65_535],
            [TEST_CONFIG.TEST_MODE, 'automatic'],
            [TEST_CONFIG.TEST_URLS, ['https://relay.example/a', 'https://relay.example/b']],
        ] as const;
        for (const [entry, value] of samples) {
            const validated = validateServerConfigValue(entry, value);
            expect(validated.ok).toBe(true);
            if (!validated.ok) continue;
            const env = { [entry.key]: serializeServerConfigValue(entry, validated.value) };
            expect(readServerConfig(env, entry)).toEqual(validated.value);
        }
    });
});

describe('registry declaration rules', () => {
    it('accepts only absolute HTTPS relay addresses from a Home write, as the Iroh runtime requires', () => {
        const relays = SERVER_CONFIG.HAPPIER_IROH_RELAY_URLS;
        expect(validateServerConfigValue(relays, ['https://relay.northwind.example'])).toEqual({ ok: true, value: ['https://relay.northwind.example'] });
        expect(validateServerConfigValue(relays, ['relay.northwind.example'])).toEqual({ ok: false, reason: 'invalid_type' });
        expect(validateServerConfigValue(relays, ['http://relay.northwind.example'])).toEqual({ ok: false, reason: 'out_of_bounds' });
    });

    it('groups Sentry tuning separately while keeping reporting destinations in monitoring', () => {
        expect(Object.values(SERVER_CONFIG_REGISTRY_BASE)
            .filter((entry) => entry.group === 'errorReporting')
            .map((entry) => entry.key).sort()).toEqual([
                'HAPPIER_SENTRY_USE_CENTRAL_DSN', 'SENTRY_ENABLE_LOGS', 'SENTRY_ENVIRONMENT',
                'SENTRY_LOG_LEVELS', 'SENTRY_MONITORS_ENABLED', 'SENTRY_PROFILE_LIFECYCLE',
                'SENTRY_PROFILE_SESSION_SAMPLE_RATE', 'SENTRY_RELEASE', 'SENTRY_SEND_DEFAULT_PII',
                'SENTRY_TRACES_SAMPLE_RATE',
            ].sort());
        expect(SERVER_CONFIG.SENTRY_DSN.group).toBe('monitoring');
        expect(SERVER_CONFIG.HAPPIER_SENTRY_CENTRAL_DSN.group).toBe('monitoring');
    });

    it('rejects empty or padded group identifiers when loading declarations', () => {
        for (const group of ['', ' ', ' errorReporting', 'errorReporting ']) {
            expect(() => defineServerConfigRegistry({ TEST_MODE: { ...TEST_CONFIG.TEST_MODE, group } })).toThrow();
        }
        expect(() => defineServerConfigRegistry({ TEST_MODE: { ...TEST_CONFIG.TEST_MODE, group: 'errorReporting' } })).not.toThrow();
    });

    it('rejects malformed applicability rules when loading declarations', () => {
        const base = TEST_CONFIG.TEST_MODE;
        for (const appliesWhen of [
            { key: 'bad-key', values: ['s3'] },
            { key: 'TEST_MODE', values: ['s3'] },
            { key: 'FILES_BACKEND', values: [] },
            { key: 'FILES_BACKEND', values: [''] },
        ]) {
            expect(() => defineServerConfigRegistry({ TEST_MODE: { ...base, appliesWhen } })).toThrow();
        }
        const missing = defineServerConfigRegistry({
            TEST_MODE: { ...base, appliesWhen: { key: 'MISSING_BACKEND', values: ['s3'] } },
        });
        expect(() => composeServerConfigRegistry(missing)).toThrow();
        const invalidChoice = defineServerConfigRegistry({
            DEPENDENT_MODE: { ...base, appliesWhen: { key: 'TEST_MODE', values: ['s3'] } },
        });
        expect(() => composeServerConfigRegistry(TEST_CONFIG, invalidChoice)).toThrow();
    });

    it('declares closed codec domains as choices and refuses arbitrary text while keeping genuine strings open', () => {
        // Domains observed at config/backends.ts and features/embeddedFeaturePolicy.ts.
        const domains = {
            HAPPIER_FILES_BACKEND: ['local', 's3'],
            HAPPIER_SOCKET_ADAPTER: ['memory', 'redis-streams'],
            HAPPIER_FEATURE_POLICY_ENV: ['production', 'preview'],
        } as const;
        for (const entry of Object.values(SERVER_CONFIG_REGISTRY_BASE)) {
            const domain = domains[entry.key as keyof typeof domains];
            if (domain) {
                expect(entry.type, entry.key).toBe('enum');
                expect(entry.bounds?.values, entry.key).toEqual(domain);
            }
            if (entry.type === 'enum') {
                for (const value of entry.bounds?.values ?? []) {
                    expect(parseServerConfigRaw(entry, value), entry.key).toEqual({ kind: 'value', value });
                    expect(validateServerConfigValue(entry, value), entry.key).toEqual({ ok: true, value });
                }
                expect(validateServerConfigValue(entry, 'not-a-config-choice'), entry.key).toEqual({ ok: false, reason: 'out_of_bounds' });
            }
            if (entry.type === 'string' && !entry.normalizeStringValue) {
                expect(parseServerConfigRaw(entry, 'not-a-config-choice'), entry.key).toEqual({ kind: 'value', value: 'not-a-config-choice' });
            }
        }
    });

    it('normalizes historical backend and feature-policy values into the declared choice domain', () => {
        const samples = [
            [SERVER_CONFIG.HAPPIER_FILES_BACKEND, ' DiSk ', 'local'],
            [SERVER_CONFIG.HAPPIER_FILES_BACKEND, 'fs', 'local'],
            [SERVER_CONFIG.HAPPIER_FILES_BACKEND, 'file', 'local'],
            [SERVER_CONFIG.HAPPIER_FILES_BACKEND, 'MINIO', 's3'],
            [SERVER_CONFIG.HAPPIER_SOCKET_ADAPTER, 'mem', 'memory'],
            [SERVER_CONFIG.HAPPIER_SOCKET_ADAPTER, 'redis', 'redis-streams'],
            [SERVER_CONFIG.HAPPIER_SOCKET_ADAPTER, 'redis_streams', 'redis-streams'],
            [SERVER_CONFIG.HAPPIER_FEATURE_POLICY_ENV, 'prod', 'production'],
            [SERVER_CONFIG.HAPPIER_FEATURE_POLICY_ENV, 'stable', 'production'],
        ] as const;
        for (const [entry, raw, canonical] of samples) {
            expect(readServerConfig({ [entry.key]: raw }, entry), entry.key).toBe(canonical);
            expect(validateServerConfigValue(entry, raw), entry.key).toEqual({ ok: true, value: canonical });
            expect(serializeServerConfigValue(entry, canonical), entry.key).toBe(canonical);
        }
        expect(readServerConfig({ HAPPY_FILES_BACKEND: 'minio' }, SERVER_CONFIG.HAPPIER_FILES_BACKEND)).toBe('s3');
        expect(readServerConfig({ HAPPY_SOCKET_ADAPTER: 'redis' }, SERVER_CONFIG.HAPPIER_SOCKET_ADAPTER)).toBe('redis-streams');
    });

    it('declares presence logging as boolean, preserves legacy env truthiness, and round-trips Off', () => {
        const entry = SERVER_CONFIG.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
        expect(entry.type).toBe('boolean');
        expect(readServerConfig({}, entry)).toBe(false);
        for (const raw of ['true', 'false', '0', 'debug', ' ']) {
            expect(readServerConfig({ [entry.key]: raw }, entry), raw).toBe(true);
        }
        expect(readServerConfig({ [entry.key]: '' }, entry)).toBe(false);
        expect(validateServerConfigValue(entry, 'false')).toEqual({ ok: false, reason: 'invalid_type' });
        for (const value of [false, true]) {
            expect(validateServerConfigValue(entry, value)).toEqual({ ok: true, value });
            expect(readServerConfig({ [entry.key]: serializeServerConfigValue(entry, value) }, entry)).toBe(value);
        }
    });

    it('refuses a default on a secret and a key or alias declared twice', () => {
        expect(() =>
            defineServerConfigRegistry({
                SECRET_KEY: { type: 'string', default: 'x', sensitivity: 'secret', apply: 'restart', editable: 'bootstrap', section: 'server', description: 'Secret.', readOnlyReason: 'before_database', reason: 'Read before the database opens.' },
            }),
        ).toThrow(/secret entry cannot declare a default/);
        const other = defineServerConfigRegistry({
            OTHER_PORT: { type: 'int', sensitivity: 'plain', apply: 'restart', editable: 'home', section: 'server', aliases: ['LEGACY_TEST_PORT'], description: 'Other.' },
        });
        expect(() => composeServerConfigRegistry(TEST_CONFIG, other)).toThrow(/LEGACY_TEST_PORT is already declared by TEST_PORT/);
    });
});
