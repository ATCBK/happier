import type { TeamAdmissionModeApplicabilityV1 } from "@happier-dev/protocol/teams";

import { readIdentityProviderRuntimeCurrentnessByIdsInTx, type IdentityProviderRuntimeCurrentness } from "@/app/auth/providers/identityProviderCatalog";
import {
    readHomeGovernancePolicyInTx,
    resolveTeamProviderKindPolicy,
    type HomeGovernancePolicyRecord,
} from "@/app/home/governance/governancePolicy";
import {
    readDirectorySourceCompletedEvidenceAllowedByIdsInTx,
    isDirectorySourceProjectionComplete,
    resolveDirectorySourceProviderKind,
} from "@/app/teams/directory/directorySourcePolicy";
import type { Tx } from "@/storage/inTx";

import { listTeamIdentityConnectionsInTx, type TeamIdentityConnectionView } from "./teamIdentityConnectionLifecycle";

type TeamAdmissionModeApplicabilityInput = Readonly<{
    tx: Tx;
    env: NodeJS.ProcessEnv;
    teamId: string;
    /** Facts already admitted by the enclosing list in this same transaction. */
    admitted?: Readonly<{
        home: HomeGovernancePolicyRecord;
        connections: readonly TeamIdentityConnectionView<string | null>[];
        runtimeCurrentness: ReadonlyMap<string, IdentityProviderRuntimeCurrentness>;
        rawConnectionCount?: number;
    }>;
}>;

/**
 * Resolves the current server-owned admission choices for one exact Team.
 *
 * The result is intentionally derived inside the caller's transaction. It is
 * an administration projection and mutation guard, not persisted readiness:
 * Home policy, directory run fencing, connection documents, provider state,
 * and executable runtime are read for every operation, sharing facts already
 * admitted by an enclosing owner in the same transaction when present.
 */
export async function resolveTeamAdmissionModeApplicabilityInTx(
    input: TeamAdmissionModeApplicabilityInput,
): Promise<TeamAdmissionModeApplicabilityV1> {
    const [home, directorySources, rawConnectionCount, connections] = await Promise.all([
        input.admitted?.home ?? readHomeGovernancePolicyInTx(input.tx),
        input.tx.teamDirectorySource.findMany({
            where: { teamId: input.teamId },
            select: { id: true, kind: true, state: true, activeReconcileRunId: true },
        }),
        input.admitted?.rawConnectionCount ?? input.tx.teamIdentityConnection.count({ where: { teamId: input.teamId } }),
        input.admitted?.connections.filter((connection): connection is TeamIdentityConnectionView => connection.teamId === input.teamId)
            ?? listTeamIdentityConnectionsInTx(input.tx, { teamId: input.teamId }),
    ]);
    const allowedConnections = connections.filter(connection => resolveTeamProviderKindPolicy(home, connection.providerKind) === "allowed");
    const connected = allowedConnections.filter(connection => connection.enabled && connection.state === "connected");
    const currentRuntimes = input.admitted?.runtimeCurrentness ?? await readIdentityProviderRuntimeCurrentnessByIdsInTx(input.tx, {
        env: input.env, home,
        context: { kind: "team", teamId: input.teamId },
        providerIds: home.teamProviders.status === "narrowed" && home.teamProviders.policy.teamJitAllowed
            ? connected.map(connection => connection.providerInstanceId) : [],
    });

    const provisioned = await (async (): Promise<TeamAdmissionModeApplicabilityV1["modes"]["provisioned"]> => {
        if (directorySources.length === 0) {
            return { status: "unavailable", reason: "directory_source_required" };
        }
        const completedAllowed = await readDirectorySourceCompletedEvidenceAllowedByIdsInTx(input.tx, {
            sources: directorySources, home, runtimeCurrentness: currentRuntimes,
        });
        if ([...completedAllowed.values()].some(Boolean)) return { status: "available" };

        const providerPolicies = directorySources.map((source) => resolveTeamProviderKindPolicy(
            home,
            resolveDirectorySourceProviderKind(source.kind),
        ));
        if (providerPolicies.some((policy) => policy === "unavailable")) {
            return { status: "unavailable", reason: "home_policy_unavailable" };
        }
        if (providerPolicies.every((policy) => policy === "prohibited")) {
            return { status: "unavailable", reason: "home_policy_prohibited" };
        }
        if (directorySources.some((source) => !isDirectorySourceProjectionComplete(source))) {
            return { status: "unavailable", reason: "directory_projection_required" };
        }
        return { status: "unavailable", reason: "team_connection_unavailable" };
    })();

    const jit = await (async (): Promise<TeamAdmissionModeApplicabilityV1["modes"]["jit"]> => {
        if (home.teamProviders.status !== "narrowed") {
            return { status: "unavailable", reason: "home_policy_unavailable" };
        }
        if (!home.teamProviders.policy.teamJitAllowed) {
            return { status: "unavailable", reason: "home_policy_prohibited" };
        }
        if (rawConnectionCount === 0) {
            return { status: "unavailable", reason: "team_connection_required" };
        }
        if (connections.length === 0) {
            return { status: "unavailable", reason: "team_connection_unavailable" };
        }

        if (allowedConnections.length === 0) {
            return rawConnectionCount > connections.length
                ? { status: "unavailable", reason: "team_connection_unavailable" }
                : { status: "unavailable", reason: "home_policy_prohibited" };
        }
        return connected.some(connection => currentRuntimes.get(connection.providerInstanceId.trim().toLowerCase())?.oauthRuntimeAvailable === true)
            ? { status: "available" }
            : { status: "unavailable", reason: "team_connection_unavailable" };
    })();

    return {
        v: 1,
        modes: {
            invite_only: { status: "available" },
            provisioned,
            jit,
        },
    };
}
