import type { HomeTeamProviderPolicyReadV1, HomeTeamProviderPolicyV1, ManagedIdentityProviderKindV1 } from '@happier-dev/protocol/home/governance';

import { resolveWorkosPlatformRuntimeMetadata } from "@/app/integrations/workos/workosPlatform";
import { resolveConfiguredPublicServerUrl } from "@/app/serverUrls/effectiveServerUrls";

const TEAM_PROVIDER_KINDS: readonly ManagedIdentityProviderKindV1[] = [
    "oidc",
    "workos_sso",
    "github_app_identity",
];

export type TeamProviderKindDeploymentAvailability =
    | "available"
    | "workos_platform_unavailable"
    | "provider_setup_unavailable";

/**
 * Whether this deployment can run a Team identity provider of `kind` at all.
 *
 * This is the deployment ceiling a Home inherits when it stores no Team-provider
 * narrowing (teams-lane-01/02 :230, :234): WorkOS needs the operator's platform
 * configuration, and managed OIDC/GitHub App identity need the public callback
 * origin. The provider catalog's setup choices and the Home policy writer both
 * read this one answer, so they cannot disagree about what the deployment allows.
 */
export function resolveTeamProviderKindDeploymentAvailability(
    env: NodeJS.ProcessEnv,
    kind: ManagedIdentityProviderKindV1,
): TeamProviderKindDeploymentAvailability {
    if (kind === "workos_sso") {
        return resolveWorkosPlatformRuntimeMetadata(env).available ? "available" : "workos_platform_unavailable";
    }
    return resolveConfiguredPublicServerUrl(env) !== null ? "available" : "provider_setup_unavailable";
}

/** The Team provider kinds this deployment can run, in canonical order. */
export function resolveDeploymentTeamProviderKinds(
    env: NodeJS.ProcessEnv,
): readonly ManagedIdentityProviderKindV1[] {
    return TEAM_PROVIDER_KINDS.filter((kind) =>
        resolveTeamProviderKindDeploymentAvailability(env, kind) === "available");
}

/**
 * A stored Team-provider policy may only narrow the deployment ceiling. A save
 * may keep kinds the current document already allows (so a later deployment
 * change never forces an unrelated edit to drop them), but it may not add a kind
 * the deployment cannot run. Clearing back to inheritance is always allowed.
 */
export function isHomeTeamProviderPolicyWithinDeploymentCeiling(input: Readonly<{
    env: NodeJS.ProcessEnv;
    current: HomeTeamProviderPolicyReadV1;
    next: HomeTeamProviderPolicyV1 | null;
}>): boolean {
    if (input.next === null) return true;
    const retained = new Set<ManagedIdentityProviderKindV1>(
        input.current.status === "narrowed" ? input.current.policy.allowedTeamProviderKinds : [],
    );
    const deployable = new Set(resolveDeploymentTeamProviderKinds(input.env));
    return input.next.allowedTeamProviderKinds.every((kind) => retained.has(kind) || deployable.has(kind));
}
