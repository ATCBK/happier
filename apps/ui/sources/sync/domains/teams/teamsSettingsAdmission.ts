import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';

/**
 * Why one Home in the exact set cannot currently offer Teams. `unresolved` is
 * deliberately distinct from `disabled`: a Home we could not reach has not said
 * "no", and the surface must explain that instead of hiding it.
 */
export type TeamsHomeAdmissionEntry =
    | Readonly<{ serverId: string; state: 'capable' }>
    | Readonly<{ serverId: string; state: 'disabled' }>
    | Readonly<{ serverId: string; state: 'unsupported'; reason: 'endpoint_missing' | 'misconfigured' }>
    /**
     * `credential_unreadable`: the Home admitted Teams, but this device could
     * not read its own saved credential for it — neither a Home failure nor a
     * sign-out, and settled rather than loading.
     */
    | Readonly<{ serverId: string; state: 'unresolved'; reason: 'loading' | 'unreachable' | 'error' | 'credential_unreadable' }>;

export type TeamsSettingsAdmission = Readonly<{
    /** True when the exact Home set contains at least one capable Home. */
    admitted: boolean;
    /** One entry per Home in the exact set, in the caller's order. */
    homes: readonly TeamsHomeAdmissionEntry[];
    capableServerIds: readonly string[];
    unresolvedServerIds: readonly string[];
}>;

const EMPTY_ADMISSION: TeamsSettingsAdmission = Object.freeze({
    admitted: false,
    homes: Object.freeze([]) as readonly TeamsHomeAdmissionEntry[],
    capableServerIds: Object.freeze([]) as readonly string[],
    unresolvedServerIds: Object.freeze([]) as readonly string[],
});

function normalizeServerIds(serverIds: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of serverIds) {
        const serverId = typeof raw === 'string' ? raw.trim() : '';
        if (!serverId || seen.has(serverId)) continue;
        seen.add(serverId);
        out.push(serverId);
    }
    return out;
}

function resolveHomeEntry(
    serverId: string,
    snapshot: ServerFeaturesSnapshot | undefined,
    settings: FeatureLocalPolicySettings,
): TeamsHomeAdmissionEntry {
    const decision = resolveRuntimeFeatureDecisionFromSnapshot({
        featureId: 'teams',
        settings,
        snapshot: snapshot ?? { status: 'loading' },
        scope: { scopeKind: 'main_selection' },
    });

    if (!decision) return { serverId, state: 'unresolved', reason: 'loading' };
    if (decision.state === 'enabled') return { serverId, state: 'capable' };
    if (decision.state === 'disabled') return { serverId, state: 'disabled' };
    if (decision.state === 'unsupported') {
        return {
            serverId,
            state: 'unsupported',
            reason: decision.blockerCode === 'endpoint_missing' ? 'endpoint_missing' : 'misconfigured',
        };
    }
    // A received HTTP error or an identity refusal is a failed probe, not
    // evidence of transport loss. Neither admits Teams, but the reason shown
    // by every consumer must preserve that distinction.
    const reason = snapshot?.status === 'error'
        && (snapshot.reason === 'response_status' || snapshot.reason === 'identity_conflict')
        ? 'error' : 'unreachable';
    return { serverId, state: 'unresolved', reason };
}

/**
 * The Settings admission decision for the Teams destination.
 *
 * Teams appears when the exact Home set contains at least one Home whose
 * canonical `teams` feature decision is enabled. Homes that are offline or not
 * yet loaded stay listed with their canonical unavailable state so a partial
 * multi-Home view can retain its capable Homes and explain the rest truthfully.
 */
export function resolveTeamsSettingsAdmission(params: Readonly<{
    serverIds: readonly string[];
    snapshotsByServerId: Readonly<Record<string, ServerFeaturesSnapshot | undefined>>;
    settings: FeatureLocalPolicySettings;
}>): TeamsSettingsAdmission {
    const serverIds = normalizeServerIds(params.serverIds);
    if (serverIds.length === 0) return EMPTY_ADMISSION;

    const homes: TeamsHomeAdmissionEntry[] = [];
    const capableServerIds: string[] = [];
    const unresolvedServerIds: string[] = [];

    for (const serverId of serverIds) {
        const entry = resolveHomeEntry(serverId, params.snapshotsByServerId[serverId], params.settings);
        homes.push(entry);
        if (entry.state === 'capable') capableServerIds.push(serverId);
        else if (entry.state === 'unresolved') unresolvedServerIds.push(serverId);
    }

    return Object.freeze({
        admitted: capableServerIds.length > 0,
        homes: Object.freeze(homes) as readonly TeamsHomeAdmissionEntry[],
        capableServerIds: Object.freeze(capableServerIds) as readonly string[],
        unresolvedServerIds: Object.freeze(unresolvedServerIds) as readonly string[],
    });
}

/**
 * Whether the Teams destination is listed in navigation, given the admitted Homes' current
 * eligibility answers.
 *
 * Each Home decides for its viewer (`showTeams`): it hides Teams from a member who is in no Team when
 * it turned "Show Teams to members" off, or when Team creation is off. The entry is withheld only when
 * every capable Home has said so; a Home that has not answered, or predates the answer, leaves Teams
 * shown, because a Home that never chose shows Teams.
 */
export function resolveTeamsDestinationShown(params: Readonly<{
    capableServerIds: readonly string[];
    showTeamsByServerId: ReadonlyMap<string, boolean | undefined>;
}>): boolean {
    if (params.capableServerIds.length === 0) return false;
    return params.capableServerIds.some((serverId) => params.showTeamsByServerId.get(serverId) !== false);
}
