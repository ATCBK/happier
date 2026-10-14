import type { AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';

import type { SessionAccessAuthentication } from "./sessionAccessAuthentication";

/** Explicit interactive credential context for direct service-boundary tests. */
export function createPresentUserSessionAccessAuthentication(
    input: Readonly<{
        env?: NodeJS.ProcessEnv;
        authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
    }> = {},
): SessionAccessAuthentication & Readonly<{ authority: "present_user" }> {
    return {
        env: input.env ?? process.env,
        authority: "present_user",
        authenticationEvidence: input.authenticationEvidence,
    };
}
