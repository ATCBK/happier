import type { HomeSignInServicePolicyV1 } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { narrowAuthSignInServicePolicy } from "@/app/auth/authPolicy";

/**
 * The one effective Home sign-in-service composition: the deployment policy,
 * narrowed by the persisted Home policy, and withheld when `self` mode lacks
 * the Account Directory capability a self-hosted service requires.
 *
 * The synchronous `/v1/features` assembler passes no narrowing because it never
 * reads the database; the effective Home auth-method owner passes the persisted
 * narrowing. Neither composes the rule again.
 */
export function resolveEffectiveHomeSignInServicePolicy(input: Readonly<{
    envPolicy: HomeSignInServicePolicyV1 | null;
    narrowing: Readonly<{ mode: "disabled" }> | null | undefined;
    accountDirectoryCapable: boolean;
}>): HomeSignInServicePolicyV1 | null {
    const configured = narrowAuthSignInServicePolicy(input.envPolicy, input.narrowing);
    return configured?.mode === "self" && !input.accountDirectoryCapable ? null : configured;
}
