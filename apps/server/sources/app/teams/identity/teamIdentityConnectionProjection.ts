import type { TeamIdentityConnectionUserActionIdV1, IdentityConnectionUserActionIdV1, HomeIdentityConnectionUserActionIdV1 } from '@happier-dev/protocol/teams/identity/actionIds';
import type { IdentityConnectionV1, TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';
import type { HomeIdentityConnectionV1 } from '@happier-dev/protocol/home';
import { normalizeAuthMethodId } from '@happier-dev/protocol/auth/providers';

import { resolveTeamAuthenticationPolicy, resolveTeamAuthenticationPolicyInTx } from "@/app/auth/entry/resolveTeamAuthenticationPolicy";
import { resolveOAuthRuntimeByIdInTx, type IdentityProviderRuntimeCurrentness } from "@/app/auth/providers/identityProviderCatalog";
import { readHomeGovernancePolicyInTx, resolveIdentityConnectionProviderKindPolicy } from "@/app/home/governance/governancePolicy";
import { resolveWorkosPlatformRuntimeMetadata } from "@/app/integrations/workos/workosPlatform";
import type { Tx } from "@/storage/inTx";

import type { TeamIdentityConnectionView as LifecycleConnectionView } from "./teamIdentityConnectionLifecycle";
import { identityConnectionOwner } from "./teamIdentityAdministrationAuthority";

type TeamIdentityConnectionView = LifecycleConnectionView<string | null>;
export type ScopedIdentityConnectionV1<TeamId extends string | null = string | null> =
    TeamId extends null ? HomeIdentityConnectionV1 : TeamIdentityConnectionV1;

/** Preserve the connection's scope when composing its outward result envelope. */
export function projectIdentityConnectionResult<Details extends object>(
    connection: ScopedIdentityConnectionV1,
    details: Details,
): (Details & { connection: HomeIdentityConnectionV1 }) | (Details & { connection: TeamIdentityConnectionV1 }) {
    return connection.teamId === null
        ? { ...details, connection }
        : { ...details, connection };
}

export type TeamIdentityConnectionCurrentness = Readonly<{
    runtimeAvailable: boolean;
    providerAllowedByHome: boolean;
    policyStatus: "available" | "in_use" | "unavailable";
    workosPlatformAvailable: boolean;
    teamsUsingIt?: HomeIdentityConnectionV1["teamsUsingIt"];
}>;

/** Explicit Home-method uses, shared by connection presentation and removal admission. */
export async function readTeamsUsingHomeIdentityMethodsInTx(
    tx: Tx,
    providerInstanceIds: readonly string[],
): Promise<ReadonlyMap<string, NonNullable<HomeIdentityConnectionV1["teamsUsingIt"]>>> {
    const requested = new Set(providerInstanceIds.map(normalizeAuthMethodId));
    const result = new Map<string, NonNullable<HomeIdentityConnectionV1["teamsUsingIt"]>>();
    if (requested.size === 0) return result;
    const teams = await tx.team.findMany({
        select: { id: true, name: true, authenticationPolicy: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    for (const team of teams) {
        const policy = resolveTeamAuthenticationPolicy({ policy: team.authenticationPolicy, homeMethods: [], teamConnections: [] });
        if (policy.status !== "restricted") continue;
        for (const choice of policy.choices) {
            if (choice.reference.kind !== "home_method") continue;
            const providerId = normalizeAuthMethodId(choice.reference.methodId);
            if (!requested.has(providerId)) continue;
            const uses = result.get(providerId) ?? [];
            uses.push({ teamId: team.id, name: team.name });
            result.set(providerId, uses);
        }
    }
    return result;
}

export function resolveTeamIdentityConnectionCurrentState(
    connection: TeamIdentityConnectionView,
    current: TeamIdentityConnectionCurrentness,
): TeamIdentityConnectionView["state"] {
    if (!current.providerAllowedByHome) return "prohibited";
    if (connection.providerKind === "workos_sso" && !current.workosPlatformAvailable) return "unavailable";
    // A draft has no runtime yet by definition: its absence is setup work
    // still to do, not an outage of something that used to work.
    if (!current.runtimeAvailable && connection.state !== "setting_up") return "unavailable";
    return connection.state;
}

/**
 * Inputs to currentness that are the same for every connection of one Team:
 * the Home's provider ceiling, the Team's accepted-authentication policy and
 * the WorkOS platform. Resolved once per request by the list path and reused
 * across its rows; a single mutation result resolves them for its one row.
 */
export type TeamIdentityCurrentnessInputs = Readonly<{
    home: Awaited<ReturnType<typeof readHomeGovernancePolicyInTx>>;
    policyStatusFor: (connectionId: string) => TeamIdentityConnectionCurrentness["policyStatus"];
    workosPlatformAvailable: boolean;
    teamsUsingHomeMethods: ReadonlyMap<string, NonNullable<HomeIdentityConnectionV1["teamsUsingIt"]>>;
    runtimeCurrentness?: ReadonlyMap<string, IdentityProviderRuntimeCurrentness>;
}>;

export async function readTeamIdentityCurrentnessInputsInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv; teamId: string | null; homeProviderInstanceIds?: readonly string[];
        home?: Awaited<ReturnType<typeof readHomeGovernancePolicyInTx>>;
        runtimeCurrentness?: ReadonlyMap<string, IdentityProviderRuntimeCurrentness>;
    }>,
): Promise<TeamIdentityCurrentnessInputs> {
    const [team, home, teamsUsingHomeMethods] = await Promise.all([
        input.teamId === null ? Promise.resolve(null) : tx.team.findUnique({ where: { id: input.teamId }, select: { authenticationPolicy: true } }),
        input.home ?? readHomeGovernancePolicyInTx(tx),
        readTeamsUsingHomeIdentityMethodsInTx(tx, input.teamId === null ? input.homeProviderInstanceIds ?? [] : []),
    ]);
    const policy = team && input.teamId !== null
        ? await resolveTeamAuthenticationPolicyInTx(tx, {
            env: input.env,
            teamId: input.teamId,
            policy: team.authenticationPolicy,
        })
        : null;
    return {
        home,
        policyStatusFor: (connectionId) => {
            if (input.teamId === null) return "available";
            if (!policy || policy.resolution.status === "unavailable") return "unavailable";
            return policy.resolution.status === "restricted"
                && policy.resolution.choices.some((choice) =>
                    choice.reference.kind === "team_connection"
                    && choice.reference.connectionId === connectionId)
                ? "in_use"
                : "available";
        },
        workosPlatformAvailable: resolveWorkosPlatformRuntimeMetadata(input.env).available,
        teamsUsingHomeMethods,
        ...(input.runtimeCurrentness ? { runtimeCurrentness: input.runtimeCurrentness } : {}),
    };
}

/**
 * The one currentness resolution behind every outward connection projection.
 *
 * A database-enabled row alone never reports `connected`: whether the exact
 * runtime resolves, whether the Home still allows the kind, whether the Team
 * policy names the connection and whether the WorkOS platform is configured
 * are read here, so list, detail, CLI and mutation results all answer from the
 * same inputs.
 */
export async function resolveTeamIdentityConnectionCurrentnessInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        teamId: string | null;
        connection: TeamIdentityConnectionView;
        inputs?: TeamIdentityCurrentnessInputs;
    }>,
): Promise<Readonly<{ currentness: TeamIdentityConnectionCurrentness; runtimeFingerprint: string | null }>> {
    const shared = input.inputs ?? await readTeamIdentityCurrentnessInputsInTx(tx, {
        ...input, homeProviderInstanceIds: [input.connection.providerInstanceId],
    });
    const runtime = shared.runtimeCurrentness ? null : await resolveOAuthRuntimeByIdInTx(
        tx,
        input.env,
        input.connection.providerInstanceId,
        identityConnectionOwner(input.teamId),
        "identity_connection_test",
    );
    const runtimeFingerprint = shared.runtimeCurrentness
        ? shared.runtimeCurrentness.get(input.connection.providerInstanceId)?.runtimeFingerprint ?? null
        : runtime?.reference.runtimeFingerprint ?? null;
    return {
        currentness: {
            runtimeAvailable: runtimeFingerprint !== null,
            providerAllowedByHome: resolveIdentityConnectionProviderKindPolicy(shared.home, identityConnectionOwner(input.teamId), input.connection.providerKind) === "allowed",
            policyStatus: shared.policyStatusFor(input.connection.id),
            workosPlatformAvailable: shared.workosPlatformAvailable,
            ...(input.teamId === null ? {
                teamsUsingIt: shared.teamsUsingHomeMethods.get(normalizeAuthMethodId(input.connection.providerInstanceId)) ?? [],
            } : {}),
        },
        runtimeFingerprint,
    };
}

/** The projection every mutation result and list row returns: current state and allowed Actions from the one owner. */
export function projectCurrentTeamIdentityConnectionV1InTx<TeamId extends string | null>(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        teamId: TeamId;
        connection: LifecycleConnectionView<TeamId>;
        inputs?: TeamIdentityCurrentnessInputs;
    }>,
): Promise<ScopedIdentityConnectionV1<TeamId>>;
export async function projectCurrentTeamIdentityConnectionV1InTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        teamId: string | null;
        connection: TeamIdentityConnectionView;
        inputs?: TeamIdentityCurrentnessInputs;
    }>,
): Promise<ScopedIdentityConnectionV1> {
    const current = await resolveTeamIdentityConnectionCurrentnessInTx(tx, input);
    return projectTeamIdentityConnectionV1(input.connection, current.currentness, current.runtimeFingerprint);
}

export function projectTeamIdentityConnectionV1(
    connection: TeamIdentityConnectionView,
    current: TeamIdentityConnectionCurrentness,
    currentRuntimeFingerprint: string | null,
): ScopedIdentityConnectionV1 {
    const observation = connection.lastObservation;
    const shared: Omit<IdentityConnectionV1, "teamId" | "allowedActions"> = {
        v: 1,
        id: connection.id,
        provider: {
            id: connection.providerInstanceId,
            kind: connection.providerKind,
            displayName: connection.providerDisplayName,
        },
        externalReference: connection.externalReference,
        settings: connection.settings,
        enabled: connection.enabled,
        firstEnabledAt: connection.firstEnabledAt?.getTime() ?? null,
        revision: connection.revision,
        state: resolveTeamIdentityConnectionCurrentState(connection, current),
        lastObservation: observation === null
            ? null
            : observation.kind === "workos_sso"
                ? {
                    v: 1,
                    kind: "workos_sso",
                    presentation: observation.presentation === null
                        ? null
                        : {
                            displayName: observation.presentation.displayName,
                            strategy: observation.presentation.strategy,
                            status: observation.presentation.status,
                            lastCheckedAt: new Date(observation.presentation.lastCheckedAt).getTime(),
                        },
                }
                : { v: 1, kind: observation.kind },
        lastSuccessfulTest: connection.lastSuccessfulTest === null
            ? null
            : {
                at: connection.lastSuccessfulTest.at.getTime(),
                runtimeFingerprint: connection.lastSuccessfulTest.runtimeFingerprint,
                current: currentRuntimeFingerprint !== null
                    && connection.lastSuccessfulTest.runtimeFingerprint === currentRuntimeFingerprint,
            },
        createdAt: connection.createdAt.getTime(),
        updatedAt: connection.updatedAt.getTime(),
    };
    return { ...shared, ...projectTeamIdentityConnectionScope(connection, current) };
}

function projectTeamIdentityConnectionScope(
    connection: TeamIdentityConnectionView,
    current: TeamIdentityConnectionCurrentness,
): Readonly<{ teamId: string; allowedActions: TeamIdentityConnectionUserActionIdV1[] }>
    | Readonly<{ teamId: null; allowedActions: HomeIdentityConnectionUserActionIdV1[]; teamsUsingIt?: HomeIdentityConnectionV1["teamsUsingIt"] }> {
    const actions: TeamIdentityConnectionUserActionIdV1[] = ["teams.identity.connections.remove"];
    if (connection.providerKind === "oidc") {
        actions.unshift("teams.identity.connections.settings.update");
    }
    if (connection.enabled) {
        if (current.policyStatus === "available") {
            actions.unshift("teams.identity.connections.disable");
        }
    } else if (current.providerAllowedByHome && current.runtimeAvailable) {
        actions.unshift("teams.identity.connections.enable");
    }
    if (current.providerAllowedByHome && current.runtimeAvailable) {
        actions.push("teams.identity.connections.test.start");
    }
    if (
        current.providerAllowedByHome
        && connection.externalReference.kind === "workos_sso"
        && current.workosPlatformAvailable
    ) {
        actions.push("teams.identity.workos.adminPortalLink.create");
        if (connection.externalReference.organizationId !== null) {
            actions.push(
                "teams.identity.workos.reconcile",
                "teams.identity.workos.connection.set",
            );
        }
    }
    if (connection.teamId !== null) return { teamId: connection.teamId, allowedActions: [...new Set(actions)] };
    const homeActions = {
        "teams.identity.connections.settings.update": "home.identity.connections.settings.update",
        "teams.identity.connections.enable": "home.identity.connections.enable",
        "teams.identity.connections.disable": "home.identity.connections.disable",
        "teams.identity.connections.remove": "home.identity.connections.remove",
        "teams.identity.connections.test.start": "home.identity.connections.test.start",
        "teams.identity.workos.adminPortalLink.create": "home.identity.workos.adminPortalLink.create",
        "teams.identity.workos.reconcile": "home.identity.workos.reconcile",
        "teams.identity.workos.connection.set": "home.identity.workos.connection.set",
    } as const satisfies Record<TeamIdentityConnectionUserActionIdV1, IdentityConnectionUserActionIdV1>;
    return {
        teamId: null, allowedActions: [...new Set(actions.map((action) => homeActions[action]))],
        ...(current.teamsUsingIt !== undefined ? { teamsUsingIt: current.teamsUsingIt } : {}),
    };
}
