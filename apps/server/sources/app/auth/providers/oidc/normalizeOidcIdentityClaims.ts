import {
    ACCOUNT_IDENTITY_PROVIDER_LOGIN_MAX_CODE_UNITS,
    ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS,
} from "@/app/auth/providers/accountIdentityBounds";

export interface OidcIdentityClaimMapping {
    login: string;
    email: string;
    groups: string;
}

export interface NormalizedOidcIdentityClaims {
    subject: string;
    name?: string;
    login: string | null;
    email: string | null;
    emailVerified: boolean;
    groups: readonly string[] | null;
    groupsIncomplete: boolean;
}

export type OidcIdentityClaimsInvalidReason =
    | "id_token_claims_invalid"
    | "subject_invalid"
    | "userinfo_invalid"
    | "userinfo_subject_mismatch"
    | "login_invalid"
    | "email_invalid"
    | "email_verified_invalid"
    | "claim_names_invalid"
    | "groups_invalid";

export type NormalizeOidcIdentityClaimsResult =
    | Readonly<{ ok: true; value: Readonly<NormalizedOidcIdentityClaims> }>
    | Readonly<{ ok: false; error: "oidc_claims_invalid"; reason: OidcIdentityClaimsInvalidReason }>;

type PlainRecord = Record<string, unknown>;

const PROFILE_STRUCTURAL_CLAIMS = new Set([
    "sub",
    "email_verified",
    "_claim_names",
    "_claim_sources",
    "__proto__",
]);

function isPlainRecord(value: unknown): value is PlainRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function invalid(reason: OidcIdentityClaimsInvalidReason): NormalizeOidcIdentityClaimsResult {
    return Object.freeze({ ok: false, error: "oidc_claims_invalid", reason });
}

function hasOwn(record: PlainRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function readSupplementedClaim(idTokenClaims: PlainRecord, userInfo: PlainRecord | null, key: string): {
    present: boolean;
    value: unknown;
} {
    if (userInfo && hasOwn(userInfo, key)) return { present: true, value: userInfo[key] };
    if (hasOwn(idTokenClaims, key)) return { present: true, value: idTokenClaims[key] };
    return { present: false, value: undefined };
}

function readNormalizedString(params: {
    idTokenClaims: PlainRecord;
    userInfo: PlainRecord | null;
    keys: readonly string[];
    invalidReason: "login_invalid" | "email_invalid";
}):
    | { ok: true; value: string | null; source: "id_token" | "userinfo" | null }
    | { ok: false; result: NormalizeOidcIdentityClaimsResult } {
    const seen = new Set<string>();
    for (const key of params.keys) {
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const claim = readSupplementedClaim(params.idTokenClaims, params.userInfo, key);
        if (!claim.present) continue;
        if (typeof claim.value !== "string") {
            return { ok: false, result: invalid(params.invalidReason) };
        }
        const normalized = claim.value.trim().toLowerCase();
        if (normalized) {
            if (normalized.length > ACCOUNT_IDENTITY_PROVIDER_LOGIN_MAX_CODE_UNITS) {
                return { ok: false, result: invalid(params.invalidReason) };
            }
            return {
                ok: true,
                value: normalized,
                source: params.userInfo && hasOwn(params.userInfo, key) ? "userinfo" : "id_token",
            };
        }
    }
    return { ok: true, value: null, source: null };
}

type GroupEvidence =
    | { ok: true; present: false }
    | { ok: true; present: true; groups: readonly string[] | null; groupsIncomplete: boolean }
    | { ok: false; result: NormalizeOidcIdentityClaimsResult };

function readGroupsFromRecord(record: PlainRecord, claimName: string): GroupEvidence {
    if (hasOwn(record, "_claim_names")) {
        const claimNames = record._claim_names;
        if (!isPlainRecord(claimNames) && claimName !== "_claim_names") {
            return { ok: false, result: invalid("claim_names_invalid") };
        }
        if (isPlainRecord(claimNames) && hasOwn(claimNames, claimName)) {
            const sourceName = claimNames[claimName];
            if (typeof sourceName !== "string" || !sourceName.trim()) {
                return { ok: false, result: invalid("claim_names_invalid") };
            }
            return { ok: true, present: true, groups: null, groupsIncomplete: true };
        }
    }

    if (!hasOwn(record, claimName)) return { ok: true, present: false };
    const value = record[claimName];

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (!normalized) return { ok: false, result: invalid("groups_invalid") };
        return { ok: true, present: true, groups: Object.freeze([normalized]), groupsIncomplete: false };
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        return { ok: false, result: invalid("groups_invalid") };
    }

    const groups: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        const normalized = entry.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        groups.push(normalized);
    }
    return { ok: true, present: true, groups: Object.freeze(groups), groupsIncomplete: false };
}

function readGroups(params: {
    idTokenClaims: PlainRecord;
    userInfo: PlainRecord | null;
    claimName: string;
}): Exclude<GroupEvidence, { ok: true; present: false }> {
    if (params.userInfo) {
        const userInfoEvidence = readGroupsFromRecord(params.userInfo, params.claimName);
        if (!userInfoEvidence.ok || userInfoEvidence.present) return userInfoEvidence;
    }
    const idTokenEvidence = readGroupsFromRecord(params.idTokenClaims, params.claimName);
    if (!idTokenEvidence.ok || idTokenEvidence.present) return idTokenEvidence;
    return { ok: true, present: true, groups: null, groupsIncomplete: false };
}

export function normalizeOidcIdentityClaims(params: {
    idTokenClaims: unknown;
    userInfo?: unknown;
    claims: OidcIdentityClaimMapping;
}): NormalizeOidcIdentityClaimsResult {
    if (!isPlainRecord(params.idTokenClaims)) return invalid("id_token_claims_invalid");

    const rawSubject = params.idTokenClaims.sub;
    if (
        typeof rawSubject !== "string"
        || rawSubject.length === 0
        || rawSubject.length > ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS
    ) return invalid("subject_invalid");
    const subject = rawSubject;

    let userInfo: PlainRecord | null = null;
    if (params.userInfo !== undefined) {
        if (!isPlainRecord(params.userInfo)) return invalid("userinfo_invalid");
        const userInfoSubject = params.userInfo.sub;
        if (
            typeof userInfoSubject !== "string"
            || userInfoSubject.length === 0
            || userInfoSubject.length > ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS
        ) return invalid("userinfo_invalid");
        if (userInfoSubject !== subject) return invalid("userinfo_subject_mismatch");
        userInfo = params.userInfo;
    }

    const login = readNormalizedString({
        idTokenClaims: params.idTokenClaims,
        userInfo,
        keys: [params.claims.login, "preferred_username", "email", "upn"],
        invalidReason: "login_invalid",
    });
    if (!login.ok) return login.result;

    const email = readNormalizedString({
        idTokenClaims: params.idTokenClaims,
        userInfo,
        keys: [params.claims.email, "email"],
        invalidReason: "email_invalid",
    });
    if (!email.ok) return email.result;

    let emailVerifiedClaim: { present: boolean; value: unknown };
    if (email.source === "userinfo" && userInfo) {
        if (hasOwn(userInfo, "email_verified")) {
            emailVerifiedClaim = { present: true, value: userInfo.email_verified };
        } else {
            const idTokenEmail = readNormalizedString({
                idTokenClaims: params.idTokenClaims,
                userInfo: null,
                keys: [params.claims.email, "email"],
                invalidReason: "email_invalid",
            });
            const sameIdTokenEmail = idTokenEmail.ok && idTokenEmail.value !== null && idTokenEmail.value === email.value;
            emailVerifiedClaim = sameIdTokenEmail && hasOwn(params.idTokenClaims, "email_verified")
                ? { present: true, value: params.idTokenClaims.email_verified }
                : { present: false, value: undefined };
        }
    } else if (email.source === "id_token") {
        emailVerifiedClaim = hasOwn(params.idTokenClaims, "email_verified")
            ? { present: true, value: params.idTokenClaims.email_verified }
            : { present: false, value: undefined };
    } else {
        emailVerifiedClaim = readSupplementedClaim(params.idTokenClaims, userInfo, "email_verified");
    }
    if (emailVerifiedClaim.present && typeof emailVerifiedClaim.value !== "boolean") {
        return invalid("email_verified_invalid");
    }

    const groups = readGroups({
        idTokenClaims: params.idTokenClaims,
        userInfo,
        claimName: params.claims.groups,
    });
    if (!groups.ok) return groups.result;
    const displayName = readSupplementedClaim(params.idTokenClaims, userInfo, "name").value;
    const name = typeof displayName === "string" ? displayName.trim() : "";

    return Object.freeze({
        ok: true,
        value: Object.freeze({
            subject,
            ...(name ? { name } : {}),
            login: login.value,
            email: email.value,
            emailVerified: emailVerifiedClaim.value === true,
            groups: groups.groups,
            groupsIncomplete: groups.groupsIncomplete,
        }),
    });
}

export function createOidcIdentityProfile(
    claims: Readonly<NormalizedOidcIdentityClaims>,
    mapping: OidcIdentityClaimMapping,
): Record<string, string | boolean | string[] | Record<string, string>> {
    type Profile = Record<string, string | boolean | string[] | Record<string, string>>;

    const setClaim = (profile: Profile, key: string, value: Profile[string]): boolean => {
        if (hasOwn(profile, key)) return profile[key] === value;
        Object.defineProperty(profile, key, { value, enumerable: true, configurable: true, writable: true });
        return true;
    };
    const createBaseProfile = (): Profile => {
        const profile: Profile = { sub: claims.subject };
        if (claims.name) profile.name = claims.name;
        if (
            mapping.login !== "email_verified" &&
            mapping.email !== "email_verified" &&
            mapping.groups !== "email_verified"
        ) {
            profile.email_verified = claims.emailVerified;
        }
        if (claims.groupsIncomplete) {
            setClaim(profile, "_claim_names", { [mapping.groups]: "incomplete" });
        } else if (claims.groups !== null) {
            setClaim(profile, mapping.groups, claims.groups.length === 1 ? claims.groups[0] : [...claims.groups]);
        }
        return profile;
    };
    const matches = (result: NormalizeOidcIdentityClaimsResult): boolean =>
        result.ok &&
        result.value.subject === claims.subject &&
        result.value.login === claims.login &&
        result.value.email === claims.email &&
        result.value.emailVerified === claims.emailVerified &&
        result.value.groupsIncomplete === claims.groupsIncomplete &&
        (result.value.groups === claims.groups ||
            (result.value.groups !== null &&
                claims.groups !== null &&
                result.value.groups.length === claims.groups.length &&
                result.value.groups.every((group, index) => group === claims.groups![index])));
    const unique = (values: readonly (string | null)[]): (string | null)[] =>
        values.filter((value, index) => values.indexOf(value) === index);
    const loginSlots = claims.login === null
        ? [null]
        : unique([mapping.login, null, "preferred_username", "email", "upn"]);
    const emailSlots = claims.email === null
        ? [null]
        : unique([mapping.email, null, "email"]);

    for (const loginSlot of loginSlots) {
        for (const emailSlot of emailSlots) {
            const profile = createBaseProfile();
            if (loginSlot !== null && loginSlot !== "__proto__" && PROFILE_STRUCTURAL_CLAIMS.has(loginSlot)) continue;
            if (emailSlot !== null && emailSlot !== "__proto__" && PROFILE_STRUCTURAL_CLAIMS.has(emailSlot)) continue;
            if (loginSlot !== null && !setClaim(profile, loginSlot, claims.login!)) continue;
            if (emailSlot !== null && !setClaim(profile, emailSlot, claims.email!)) continue;
            if (matches(normalizeOidcIdentityClaims({ idTokenClaims: profile, claims: mapping }))) return profile;
        }
    }

    throw new Error("oidc_claims_invalid");
}
