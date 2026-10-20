import { createHappierCollectionVisitMemory } from '@happier-dev/plugin-ui/presentation';

/** Settings › Profiles: the collection's own route. */
export const PROFILES_COLLECTION_ROOT = '/settings/profiles';
const NEW_PROFILE_SEGMENT = 'new';
/** The no-profile choice (the machine's environment); not a profile id, so it never collides with one. */
const DEFAULT_ENVIRONMENT_SEGMENT = 'default-environment';

export const DEFAULT_ENVIRONMENT_ROUTE = `${PROFILES_COLLECTION_ROOT}/${DEFAULT_ENVIRONMENT_SEGMENT}`;

export function profileRoute(profileId: string): string {
    return `${PROFILES_COLLECTION_ROOT}/${encodeURIComponent(profileId)}`;
}

/** The draft of a new profile in the collection; `cloneFrom` starts it as a copy of a saved or built-in profile. */
export function newProfileRoute(cloneFrom?: string | null): string {
    const base = `${PROFILES_COLLECTION_ROOT}/${NEW_PROFILE_SEGMENT}`;
    return cloneFrom ? `${base}?cloneFrom=${encodeURIComponent(cloneFrom)}` : base;
}

export type ProfileCollectionSelection =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'draft' }>
    | Readonly<{ kind: 'defaultEnvironment' }>
    | Readonly<{ kind: 'profile'; profileId: string }>;

/** What the route selects in the collection; the rail highlights it and the detail pane shows it. */
export function resolveProfileCollectionSelection(pathname: string): ProfileCollectionSelection {
    const normalized = pathname.replace(/\/+$/, '');
    if (!normalized.startsWith(`${PROFILES_COLLECTION_ROOT}/`)) return { kind: 'none' };
    const segment = normalized.slice(PROFILES_COLLECTION_ROOT.length + 1).split('/')[0] ?? '';
    if (!segment) return { kind: 'none' };
    if (segment === NEW_PROFILE_SEGMENT) return { kind: 'draft' };
    if (segment === DEFAULT_ENVIRONMENT_SEGMENT) return { kind: 'defaultEnvironment' };
    return { kind: 'profile', profileId: decodeURIComponent(segment) };
}

/** The nested stack screen shown at `pathname` (registry names under the `profiles` navigator). */
export function resolveProfilesChildRoute(pathname: string): string {
    const selection = resolveProfileCollectionSelection(pathname);
    if (selection.kind === 'draft') return 'new';
    if (selection.kind === 'defaultEnvironment') return 'default-environment';
    if (selection.kind === 'profile') return '[profileId]';
    return 'index';
}

/**
 * The profile last opened in the collection during this app session. A wide collection lands on it
 * when the route names no profile. Session memory only: a navigation convenience, not a preference.
 */
const profileVisits = createHappierCollectionVisitMemory<string>();

export const recordProfileCollectionVisit = profileVisits.record;
export const readLastVisitedProfileId = profileVisits.read;
