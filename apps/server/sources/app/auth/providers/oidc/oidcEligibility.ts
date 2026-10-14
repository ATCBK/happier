import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import type { OidcAuthProviderInstanceConfig } from "./oidcProviderConfig";
import type { NormalizedOidcIdentityClaims } from "./normalizeOidcIdentityClaims";

/** The same rule outcomes drive sign-in admission and administrator test diagnostics. */
export function evaluateOidcEligibility(
    allow: OidcAuthProviderInstanceConfig["allow"],
    claims: Readonly<NormalizedOidcIdentityClaims>,
) {
    const rules: { kind: "users" | "email_domains" | "groups_any" | "groups_all"; matched: boolean }[] = [];
    if (allow.usersAllowlist.length > 0) {
        rules.push({ kind: "users", matched: claims.login !== null && allow.usersAllowlist.includes(claims.login) });
    }
    if (allow.emailDomains.length > 0) {
        const mailbox = claims.emailVerified && claims.email ? normalizeVerifiedEmail(claims.email) : null;
        const domain = mailbox?.normalizedEmail.split("@")[1];
        rules.push({ kind: "email_domains", matched: Boolean(domain && allow.emailDomains.includes(domain)) });
    }
    const groups = !claims.groupsIncomplete ? claims.groups : null;
    if (allow.groupsAny.length > 0) {
        rules.push({ kind: "groups_any", matched: groups !== null && allow.groupsAny.some(group => groups.includes(group)) });
    }
    if (allow.groupsAll.length > 0) {
        rules.push({ kind: "groups_all", matched: groups !== null && allow.groupsAll.every(group => groups.includes(group)) });
    }
    return { status: rules.every(rule => rule.matched) ? "eligible" as const : "ineligible" as const, rules };
}

export type OidcEligibilityEvaluation = ReturnType<typeof evaluateOidcEligibility>;

/**
 * The single eligibility answer for one identity: the provider instance's rules plus, when the
 * identity is reached through a Team connection, that connection's additional rules.
 *
 * Sign-in admission and the administrator's test diagnostic both consume this, so a Test can
 * never report `eligible` for a subject the same connection's sign-in refuses. Rules of the same
 * kind collapse into one outcome because that is the granularity the diagnostic reports.
 */
export function evaluateOidcIdentityEligibility(params: Readonly<{
    allow: OidcAuthProviderInstanceConfig["allow"];
    additionalAllow?: OidcAuthProviderInstanceConfig["allow"];
    claims: Readonly<NormalizedOidcIdentityClaims>;
}>): OidcEligibilityEvaluation {
    const instanceEvaluation = evaluateOidcEligibility(params.allow, params.claims);
    if (!params.additionalAllow) return instanceEvaluation;

    const additionalEvaluation = evaluateOidcEligibility(params.additionalAllow, params.claims);
    const rules: OidcEligibilityEvaluation["rules"] = [];
    for (const rule of [...instanceEvaluation.rules, ...additionalEvaluation.rules]) {
        const existing = rules.find(candidate => candidate.kind === rule.kind);
        if (existing) existing.matched = existing.matched && rule.matched;
        else rules.push({ kind: rule.kind, matched: rule.matched });
    }
    return { status: rules.every(rule => rule.matched) ? "eligible" as const : "ineligible" as const, rules };
}
