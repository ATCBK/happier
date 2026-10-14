/**
 * Whether an Account still has no name of its own, so a surface may ask for one.
 *
 * Only a known profile counts: `null` (not yet in sync, or another Account's profile) never asks,
 * so a name set elsewhere is never overwritten from a guess. A username does not count as a name,
 * because colleagues would otherwise see a handle.
 */
export function isAccountMissingOwnName(profile: Readonly<{ name: string | null }> | null): boolean {
    return profile !== null && !(profile.name ?? '').trim();
}
