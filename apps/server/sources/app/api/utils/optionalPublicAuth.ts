import { auth } from "@/app/auth/auth";
import {
    resolveOptionalPublicAuthDisposition,
    type OptionalPublicAuthDisposition,
} from "@/app/api/utils/apiTokenRouteAdmission";
import { readBearerCredential } from "@/app/api/utils/verifyRequestPrincipal";

/**
 * Canonical bearer adapter for public routes where authentication is optional.
 * Invalid credentials and the established PAT/Directory cases remain anonymous;
 * a verified restricted Session runtime remains distinguishable so the caller
 * can reject it before processing a public token, cookie, or projection.
 */
export async function readOptionalPublicAuthDisposition(
    authorizationHeader: unknown,
): Promise<OptionalPublicAuthDisposition> {
    const token = readBearerCredential(authorizationHeader);
    if (token === null) return { status: "anonymous" };
    const verification = await auth.verifyTokenDisposition(token, { allowLegacyHome: true });
    return resolveOptionalPublicAuthDisposition(
        verification.status === "verified"
            ? verification.credential
            : verification.status === "rejected_restricted"
                ? verification
                : null,
    );
}
