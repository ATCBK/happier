import type { ServerConfigEnv } from '@happier-dev/protocol/serverConfig/serverConfigCodec';

import { readStartupHomeEnv } from './startupHomeEnv';

/**
 * Which source put a value into a configuration overlay (plan `2026-09-26-home-owner-console` §3.2,
 * invariants I1/I2).
 *
 * Readers keep reading an env-like object, so an overlay value is indistinguishable from an
 * operator's value by its text alone. The few decisions that must tell them apart — above all the
 * sign-in audience, which may fall back only to an address the deployment set explicitly (I1) — ask
 * here. The overlay owner stamps each value it fills; a stamp travels with object spreads (it is an
 * enumerable symbol key, which spreads copy and env iteration, JSON and child-process environments
 * ignore) and applies only while the key still holds the stamped text, so a copy that overwrites the
 * key reads as the deployment's value again. Restart values also retain their source through the active startup snapshot, including the
 * string-only copy applied to process.env. Other unstamped values are deployment configuration.
 */
export type HomeConfigValueSource = 'deployment' | 'home' | 'inferred';

type StampedSource = Exclude<HomeConfigValueSource, 'deployment'>;
type Stamps = Readonly<Record<string, Readonly<{ value: string; source: StampedSource }>>>;

const HOME_CONFIG_PROVENANCE: unique symbol = Symbol('happier.homeConfigProvenance');

type StampedEnv = ServerConfigEnv & { readonly [HOME_CONFIG_PROVENANCE]?: Stamps };

function readStamps(env: ServerConfigEnv): Stamps {
    return (env as StampedEnv)[HOME_CONFIG_PROVENANCE] ?? {};
}

/** Records the source of values an overlay filled. Call before freezing the overlay object. */
export function stampHomeConfigValues(
    overlay: Record<string, string | undefined>,
    filled: Readonly<Record<string, StampedSource>>,
): void {
    const stamps: Record<string, { value: string; source: StampedSource }> = { ...readStamps(overlay) };
    for (const [key, source] of Object.entries(filled)) {
        const value = overlay[key];
        if (value !== undefined) stamps[key] = { value, source };
    }
    (overlay as Record<PropertyKey, unknown>)[HOME_CONFIG_PROVENANCE] = Object.freeze(stamps);
}

/** The source of `env[key]`, or `null` when the key is unset or blank. */
export function readHomeConfigValueSource(env: ServerConfigEnv, key: string): HomeConfigValueSource | null {
    const value = env[key];
    if (value === undefined || value.trim() === '') return null;
    const stamp = readStamps(env)[key];
    if (stamp && stamp.value === value) return stamp.source;
    const startup = readStartupHomeEnv();
    if (startup?.snapshot.applied.includes(key) && startup.env[key] === value) return 'home';
    return 'deployment';
}
