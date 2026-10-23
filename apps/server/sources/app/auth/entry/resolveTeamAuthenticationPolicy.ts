import { normalizeAuthMethodId } from '@happier-dev/protocol/auth/providers';
import { normalizeTeamAuthenticationPolicyV1, TeamAuthenticationPolicyV1Schema, type TeamAcceptedAuthenticationV1 } from '@happier-dev/protocol/auth/entry';
import { resolveEffectiveHomeAuthMethodsInTx, type HomeAuthenticationAvailabilityCapture } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";
import { listProviderDescriptorsInTx } from "@/app/auth/providers/identityProviderCatalog";
import { readIdentityProviderInstancePresentationsByIdsInTx } from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import { readTeamIdentityConnectionsByIdInTx, teamIdentityConnectionReferenceKey } from "@/app/teams/identity/teamIdentityConnectionLifecycle";
import type { Tx } from "@/storage/inTx";

export type ResolvedTeamAuthenticationPolicy =
    | Readonly<{ status: "inherit" }>
    | Readonly<{ status: "unavailable" }>
    | Readonly<{
        status: "restricted";
        choices: readonly Readonly<{
            reference: TeamAcceptedAuthenticationV1;
            availability: "usable" | "unavailable";
        }>[];
    }>;

function sameReference(left: TeamAcceptedAuthenticationV1, right: TeamAcceptedAuthenticationV1): boolean {
    // Provider method IDs resolve through the one canonical method-id identity
    // (`normalizeAuthMethodId`), so two references to the same method written
    // with different case or surrounding whitespace are the same choice.
    // Team connection IDs are exact opaque identities and compare exactly.
    return left.kind === right.kind && (left.kind === "home_method"
        ? normalizeAuthMethodId(left.methodId) === (right.kind === "home_method" ? normalizeAuthMethodId(right.methodId) : undefined)
        : left.connectionId === (right.kind === "team_connection" ? right.connectionId : undefined));
}

/**
 * Resolves configured selectors without discarding unavailable rows. Candidate
 * availability must come from the canonical Home-method and same-Team connection
 * owners in the caller's transaction; this function does not grant availability.
 */
export function resolveTeamAuthenticationPolicy(input: Readonly<{
    policy: unknown;
    homeMethods: readonly Readonly<{ id: string; available: boolean }>[];
    teamConnections: readonly Readonly<{ id: string; available: boolean }>[];
}>): ResolvedTeamAuthenticationPolicy {
    if (input.policy === null) return { status: "inherit" };
    const parsed = TeamAuthenticationPolicyV1Schema.safeParse(input.policy);
    if (!parsed.success) return { status: "unavailable" };
    const normalized = normalizeTeamAuthenticationPolicyV1(parsed.data);
    if (normalized === null) return { status: "inherit" };

    // Provider method IDs carry one canonical identity everywhere else in this
    // module (`sameReference`) and in operation qualification. Join on that same
    // normalized form so a stored mixed-case or whitespace-padded selector is
    // not reported unavailable; connection IDs stay exact opaque identities.
    const availableHomeMethods = new Set(
        input.homeMethods.filter((method) => method.available).map((method) => normalizeAuthMethodId(method.id)),
    );
    const availableConnections = new Set(
        input.teamConnections.filter((connection) => connection.available).map((connection) => connection.id),
    );
    return {
        status: "restricted",
        choices: normalized.accepted.map((reference) => ({
            reference,
            availability: (reference.kind === "home_method"
                ? availableHomeMethods.has(normalizeAuthMethodId(reference.methodId))
                : availableConnections.has(reference.connectionId))
                ? "usable" as const
                : "unavailable" as const,
        })),
    };
}

/** What the current Home/Team catalog reads say about one accepted reference. */
export type TeamAcceptedChoiceFacts =
    | Readonly<{
        kind: "home_method";
        native: boolean;
        /** The effective Home decision currently enables at least one action. */
        offered: boolean;
        instanceUnreadable: boolean;
        /** The Home provider catalog currently lists the method (native methods need no descriptor). */
        descriptorOffered: boolean;
    }>
    | Readonly<{
        kind: "team_connection";
        connectionUnreadable: boolean;
        connected: boolean;
        /** The Team provider catalog currently lists the connection's provider. */
        descriptorOffered: boolean;
    }>;

export type TeamAcceptedChoiceAvailability = "usable" | "unavailable" | "unreadable";

/**
 * The one answer to "is this accepted reference currently usable?", shared by the
 * policy resolver (entry, administration, activation) and the credential
 * qualifier so the Team page can never offer a choice the qualifier rejects, or
 * hide one it would accept.
 *
 * `unreadable` is reserved for a fact its read owner reported it could not read.
 * A reference the catalog simply does not offer — a disabled Home method, a
 * provider kind the Home narrowed away, a disconnected connection — is
 * `unavailable`: not a way in right now, but it neither hides the Team's other
 * accepted alternatives nor turns a satisfiable policy into an unavailable one.
 */
export function resolveTeamAcceptedChoiceAvailability(
    facts: TeamAcceptedChoiceFacts,
): TeamAcceptedChoiceAvailability {
    if (facts.kind === "home_method") {
        if (facts.instanceUnreadable) return "unreadable";
        if (!facts.offered) return "unavailable";
        return facts.native || facts.descriptorOffered ? "usable" : "unavailable";
    }
    if (facts.connectionUnreadable) return "unreadable";
    return facts.connected && facts.descriptorOffered ? "usable" : "unavailable";
}

/**
 * The one set-level reduction over `resolveTeamAcceptedChoiceAvailability`,
 * shared by the policy resolver and the credential qualifier so one accepted
 * alternative can never be judged differently on the two paths.
 *
 * A policy is a disjunction: any currently usable alternative satisfies it. An
 * `unreadable` alternative is therefore only decisive when nothing else is
 * usable — then the policy's current state is genuinely unknown and both owners
 * fail closed. It must never hide the Team's other accepted alternatives, which
 * is exactly what `resolveTeamAcceptedChoiceAvailability` already documents.
 */
export function reduceTeamAcceptedChoiceAvailabilities<T>(
    availability: readonly (readonly [T, TeamAcceptedChoiceAvailability])[],
): Readonly<{ status: "readable"; usable: readonly T[] }> | Readonly<{ status: "unreadable" }> {
    const usable = availability.flatMap(([choice, value]) => value === "usable" ? [choice] : []);
    if (usable.length === 0 && availability.some(([, value]) => value === "unreadable")) {
        return { status: "unreadable" };
    }
    return { status: "readable", usable };
}

export function hasUsableTeamAuthenticationChoiceOtherThan(
    resolution: Extract<ResolvedTeamAuthenticationPolicy, { status: "restricted" }>,
    excluded: TeamAcceptedAuthenticationV1,
): boolean {
    return resolution.choices.some((choice) => choice.availability === "usable"
        && !sameReference(choice.reference, excluded));
}

/** A proposed restricted policy must leave its editor one currently usable way back in. */
export type TeamAuthenticationPolicyActivationReadiness =
    | "ready"
    | "provider_test_required"
    | "unavailable";

export type TeamAuthenticationPolicyAccountFacts = Readonly<{
    usableHomeMethodIds: readonly string[];
    usableTeamConnectionIds: readonly string[];
}>;

export type ResolvedTeamAuthenticationPolicyInTx = Readonly<{
    resolution: ResolvedTeamAuthenticationPolicy;
    activationReadiness: TeamAuthenticationPolicyActivationReadiness;
}>;

export async function resolveTeamAuthenticationPolicyInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        teamId: string;
        policy: unknown;
        accountFacts?: TeamAuthenticationPolicyAccountFacts;
        /** Share one Home availability capture across current/after-removal comparisons. */
        homeAvailability?: HomeAuthenticationAvailabilityCapture;
        /** A server-validated invitation may activate Home provisioning choices. */
        admission?: Readonly<{ kind: "team_invitation" }>;
        emailDeliveryReady?: boolean;
    }>,
): Promise<ResolvedTeamAuthenticationPolicyInTx> {
    const structural = resolveTeamAuthenticationPolicy({
        policy: input.policy,
        homeMethods: [],
        teamConnections: [],
    });
    if (structural.status !== "restricted") {
        return {
            resolution: structural,
            activationReadiness: resolveTeamAuthenticationPolicyActivationReadiness(structural, []),
        };
    }

    const acceptedHomeMethodIds = structural.choices.flatMap((choice) =>
        choice.reference.kind === "home_method" ? [normalizeAuthMethodId(choice.reference.methodId)] : []);
    const acceptedConnectionIds = structural.choices.flatMap((choice) =>
        choice.reference.kind === "team_connection" ? [choice.reference.connectionId] : []);
    const [effectiveHome, connectionReads, homeDescriptors, teamDescriptors, instances] = await Promise.all([
        input.homeAvailability?.effectiveHome ?? resolveEffectiveHomeAuthMethodsInTx(tx, {
            env: input.env,
            ...(input.admission ? { admission: input.admission } : {}),
            ...(input.emailDeliveryReady === undefined
                ? {}
                : { emailDeliveryReady: input.emailDeliveryReady }),
        }),
        readTeamIdentityConnectionsByIdInTx(tx, {
            references: acceptedConnectionIds.map((id) => ({ id, teamId: input.teamId })),
        }),
        input.homeAvailability?.providerDescriptors ?? listProviderDescriptorsInTx(tx, input.env),
        listProviderDescriptorsInTx(tx, input.env, { kind: "team", teamId: input.teamId }),
        readIdentityProviderInstancePresentationsByIdsInTx(tx, { ids: acceptedHomeMethodIds }),
    ]);
    if (effectiveHome.status !== "ready") {
        const resolution: ResolvedTeamAuthenticationPolicy = { status: "unavailable" };
        return {
            resolution,
            activationReadiness: resolveTeamAuthenticationPolicyActivationReadiness(resolution, []),
        };
    }

    const accountHomeMethods = input.accountFacts
        ? new Set(input.accountFacts.usableHomeMethodIds.map(normalizeAuthMethodId))
        : null;
    const accountConnections = input.accountFacts
        ? new Set(input.accountFacts.usableTeamConnectionIds)
        : null;
    const nativeMethodIds = new Set(resolveAuthMethodRegistry(input.env).map((method) => normalizeAuthMethodId(method.id)));
    const homeDescriptorById = new Map(homeDescriptors.map((descriptor) => [
        normalizeAuthMethodId(descriptor.reference.id),
        descriptor,
    ]));
    const teamDescriptorByProviderId = new Map(teamDescriptors.map((descriptor) => [
        normalizeAuthMethodId(descriptor.reference.id),
        descriptor,
    ]));
    const effectiveHomeById = new Map(effectiveHome.decisions.map((decision) => [normalizeAuthMethodId(decision.id), decision]));
    const connectionReadById = new Map(acceptedConnectionIds.map((id) => [id, connectionReads.get(
        teamIdentityConnectionReferenceKey({ id, teamId: input.teamId }),
    )] as const));
    const connectionById = new Map([...connectionReads.values()].flatMap((read) =>
        read.status === "ready" ? [[read.connection.id, read.connection] as const] : []));
    const homeMethodAvailability = acceptedHomeMethodIds.map((id) => [id, resolveTeamAcceptedChoiceAvailability({
        kind: "home_method",
        native: nativeMethodIds.has(id),
        offered: effectiveHomeById.get(id)?.actions.some((action) => action.enabled) === true,
        instanceUnreadable: instances.get(id)?.status === "unreadable",
        descriptorOffered: homeDescriptorById.has(id),
    })] as const);
    const teamConnectionAvailability = acceptedConnectionIds.map((id) => {
        const read = connectionReadById.get(id);
        const connection = read?.status === "ready" ? read.connection : undefined;
        return [id, resolveTeamAcceptedChoiceAvailability({
            kind: "team_connection",
            connectionUnreadable: read?.status === "unreadable",
            connected: connection?.state === "connected",
            descriptorOffered: connection !== undefined
                && teamDescriptorByProviderId.has(normalizeAuthMethodId(connection.providerInstanceId)),
        })] as const;
    });
    if (reduceTeamAcceptedChoiceAvailabilities(
        [...homeMethodAvailability, ...teamConnectionAvailability],
    ).status === "unreadable") {
        const resolution: ResolvedTeamAuthenticationPolicy = { status: "unavailable" };
        return {
            resolution,
            activationReadiness: resolveTeamAuthenticationPolicyActivationReadiness(resolution, []),
        };
    }
    const homeMethods = homeMethodAvailability.map(([id, availability]) => ({
        id,
        available: availability === "usable" && (accountHomeMethods === null || accountHomeMethods.has(id)),
    }));
    const teamConnections = teamConnectionAvailability.map(([id, availability]) => ({
        id,
        available: availability === "usable" && (accountConnections === null || accountConnections.has(id)),
    }));
    const resolution = resolveTeamAuthenticationPolicy({
        policy: input.policy,
        homeMethods,
        teamConnections,
    });
    const qualifiedReferences: TeamAcceptedAuthenticationV1[] = [];
    for (const id of acceptedHomeMethodIds) {
        if (nativeMethodIds.has(id)) {
            qualifiedReferences.push({ kind: "home_method", methodId: id });
            continue;
        }
        const descriptor = homeDescriptorById.get(id);
        const instance = instances.get(id);
        if (
            descriptor?.reference.source === "managed"
            && instance?.status === "ready"
            && instance.instance.owner.kind === "home"
            && instance.instance.enabled
            && instance.instance.lastSuccessfulTest?.securityRevision === instance.instance.securityRevision
            && instance.instance.lastSuccessfulTest.runtimeFingerprint === descriptor.reference.runtimeFingerprint
        ) {
            qualifiedReferences.push({ kind: "home_method", methodId: id });
        }
    }
    for (const id of acceptedConnectionIds) {
        const connection = connectionById.get(id);
        const successfulTest = connection?.lastSuccessfulTest;
        const descriptor = connection
            ? teamDescriptorByProviderId.get(normalizeAuthMethodId(connection.providerInstanceId))
            : undefined;
        if (
            connection !== undefined
            && descriptor !== undefined
            && successfulTest?.runtimeFingerprint === descriptor.reference.runtimeFingerprint
        ) {
            qualifiedReferences.push({ kind: "team_connection", connectionId: id });
        }
    }
    return {
        resolution,
        activationReadiness: resolveTeamAuthenticationPolicyActivationReadiness(resolution, qualifiedReferences),
    };
}

export function resolveTeamAuthenticationPolicyActivationReadiness(
    resolution: ResolvedTeamAuthenticationPolicy,
    qualifiedReferences: readonly TeamAcceptedAuthenticationV1[],
): TeamAuthenticationPolicyActivationReadiness {
    if (resolution.status === "inherit") return "ready";
    if (resolution.status === "unavailable") return "unavailable";
    const usable = resolution.choices.filter((choice) => choice.availability === "usable");
    if (usable.length === 0) return "unavailable";
    return usable.some((choice) => qualifiedReferences.some((reference) => sameReference(choice.reference, reference)))
        ? "ready"
        : "provider_test_required";
}
