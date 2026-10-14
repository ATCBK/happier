import type { HomeIdentityNetworkPolicyV1 } from '@happier-dev/protocol/home/governance';

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";
import { parseIpCidr } from "@/app/net/addressPolicy";
import { parseBooleanEnv } from "@/config/env";

export type ManagedIdentityNetworkPolicyValidation =
    | Readonly<{ status: "valid" }>
    | Readonly<{ status: "invalid"; reason: "private_network_disabled" | "invalid_cidr" }>;

/**
 * The deployment operator's outer ceiling, shared by policy admission and the
 * runtime network resolver. Absent or malformed configuration is public-only.
 */
export function deploymentAllowsPrivateIdentityNetwork(env: NodeJS.ProcessEnv): boolean {
    return parseBooleanEnv(env[FEATURE_ENV_KEYS.authManagedIdentityPrivateNetworkEnabled], false);
}

/**
 * Validates a structurally decoded Home policy against the runtime's CIDR
 * semantics and the current deployment ceiling before it can be persisted.
 */
export function validateManagedIdentityNetworkPolicyForSave(input: Readonly<{
    env: NodeJS.ProcessEnv;
    policy: HomeIdentityNetworkPolicyV1;
}>): ManagedIdentityNetworkPolicyValidation {
    if (input.policy.mode === "public_only") return { status: "valid" };
    if (!deploymentAllowsPrivateIdentityNetwork(input.env)) {
        return { status: "invalid", reason: "private_network_disabled" };
    }
    if (input.policy.cidrs.some((cidr) => parseIpCidr(cidr) === null)) {
        return { status: "invalid", reason: "invalid_cidr" };
    }
    return { status: "valid" };
}
