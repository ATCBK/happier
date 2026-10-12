import { describe, expect, it } from "vitest";

import {
    createOidcIdentityProfile,
    normalizeOidcIdentityClaims,
} from "./normalizeOidcIdentityClaims";

const mapping = Object.freeze({ login: "login_name", email: "mail", groups: "roles" });

describe("normalizeOidcIdentityClaims", () => {
    it('retains the full display name from the matching UserInfo without splitting it', () => {
        const normalized = normalizeOidcIdentityClaims({
            idTokenClaims: { sub: 'subject', name: 'Token Name' },
            userInfo: { sub: 'subject', name: '  Chosen Provider Name  ' },
            claims: mapping,
        });
        expect(normalized).toMatchObject({ ok: true, value: { name: 'Chosen Provider Name' } });
        if (normalized.ok) expect(createOidcIdentityProfile(normalized.value, mapping)).toMatchObject({ name: 'Chosen Provider Name' });
    });
    it.each([
        undefined,
        null,
        [],
        {},
        { sub: "" },
        { sub: 42 },
        { sub: true },
    ])("rejects ID-token claims without a non-empty string subject: %j", (idTokenClaims) => {
        expect(normalizeOidcIdentityClaims({ idTokenClaims, claims: mapping })).toMatchObject({
            ok: false,
            error: "oidc_claims_invalid",
        });
    });

    it.each(["  Case-Sensitive-Subject  ", "   "])("preserves the exact opaque subject, including whitespace and case: %j", (subject) => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: subject },
            claims: mapping,
        })).toEqual({
            ok: true,
            value: {
                subject,
                login: null,
                email: null,
                emailVerified: false,
                groups: null,
                groupsIncomplete: false,
            },
        });
    });

    it("rejects identity values that exceed the shared persistence-safe provider bounds", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "s".repeat(513) },
            claims: mapping,
        })).toEqual({ ok: false, error: "oidc_claims_invalid", reason: "subject_invalid" });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", login_name: "l".repeat(321) },
            claims: mapping,
        })).toEqual({ ok: false, error: "oidc_claims_invalid", reason: "login_invalid" });
    });

    it("uses configured login then preferred_username, email, and upn, normalized for comparison", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "subject",
                login_name: "  Configured.Login  ",
                preferred_username: "Preferred",
                email: "EMAIL@example.test",
                upn: "UPN@example.test",
            },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { login: "configured.login" } });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", login_name: " ", preferred_username: " Preferred " },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { login: "preferred" } });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", email: " EMAIL@example.test " },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { login: "email@example.test" } });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", upn: " UPN@example.test " },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { login: "upn@example.test" } });
    });

    it("rejects a present non-string login or email claim instead of coercing or falling back", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", login_name: 7, preferred_username: "fallback" },
            claims: mapping,
        })).toMatchObject({ ok: false, error: "oidc_claims_invalid", reason: "login_invalid" });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", mail: { address: "user@example.test" }, email: "fallback@example.test" },
            claims: mapping,
        })).toMatchObject({ ok: false, error: "oidc_claims_invalid", reason: "email_invalid" });
    });

    it("uses the configured email then email fallback and accepts only literal boolean verification", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", mail: " User@Example.Test ", email_verified: true },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { email: "user@example.test", emailVerified: true } });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", email: " Fallback@Example.Test " },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { email: "fallback@example.test", emailVerified: false } });

        for (const emailVerified of ["true", 1, "false"]) {
            expect(normalizeOidcIdentityClaims({
                idTokenClaims: { sub: "subject", email_verified: emailVerified },
                claims: mapping,
            })).toMatchObject({ ok: false, error: "oidc_claims_invalid", reason: "email_verified_invalid" });
        }
    });

    it("normalizes scalar and string-array groups with case-insensitive deduplication", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", roles: " Engineering " },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { groups: ["engineering"], groupsIncomplete: false } });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", roles: [" Engineering ", "engineering", "Sales", " "] },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { groups: ["engineering", "sales"], groupsIncomplete: false } });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", roles: [] },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { groups: [], groupsIncomplete: false } });
    });

    it.each([
        { roles: 1 },
        { roles: {} },
        { roles: " " },
        { roles: ["engineering", 7] },
        { roles: [["engineering"]] },
    ])("rejects malformed group evidence: %j", (extraClaims) => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", ...extraClaims },
            claims: mapping,
        })).toMatchObject({ ok: false, error: "oidc_claims_invalid", reason: "groups_invalid" });
    });

    it("marks mapped distributed group claims incomplete without reading claim sources", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "subject",
                roles: ["stale-group"],
                _claim_names: { roles: "source-1" },
                _claim_sources: { "source-1": { endpoint: "https://attacker.example.test/groups" } },
            },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { groups: null, groupsIncomplete: true } });
    });

    it("does not let an empty UserInfo claim-name map erase ID-token group overage", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", _claim_names: { roles: "source-1" } },
            userInfo: { sub: "subject", _claim_names: {} },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { groups: null, groupsIncomplete: true } });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", _claim_names: { roles: "source-1" } },
            userInfo: { sub: "subject", roles: ["Complete-Group"] },
            claims: mapping,
        })).toMatchObject({ ok: true, value: { groups: ["complete-group"], groupsIncomplete: false } });
    });

    it("accepts the released profile when the group claim shares the configured login claim", () => {
        const releasedMapping = { login: "preferred_username", email: "email", groups: "preferred_username" };
        const releasedProfile = {
            sub: "Subject",
            preferred_username: "Staff",
            email: "staff@example.test",
            email_verified: true,
        };

        const normalized = normalizeOidcIdentityClaims({
            idTokenClaims: releasedProfile,
            claims: releasedMapping,
        });
        expect(normalized).toEqual({
            ok: true,
            value: {
                subject: "Subject",
                login: "staff",
                email: "staff@example.test",
                emailVerified: true,
                groups: ["staff"],
                groupsIncomplete: false,
            },
        });
        if (!normalized.ok) return;

        const profile = createOidcIdentityProfile(normalized.value, releasedMapping);
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: JSON.parse(JSON.stringify(profile)) as unknown,
            claims: releasedMapping,
        })).toEqual(normalized);
    });

    it.each([
        {
            name: "subject",
            claims: { ...mapping, groups: "sub" },
            idTokenClaims: { sub: "Case-Sensitive-Subject" } as unknown,
        },
        {
            name: "custom login",
            claims: { login: "shared_claim", email: "mail", groups: "shared_claim" },
            idTokenClaims: { sub: "subject", shared_claim: "Staff" } as unknown,
        },
        {
            name: "email",
            claims: { ...mapping, groups: "mail" },
            idTokenClaims: { sub: "subject", mail: "Staff@Example.Test", email_verified: true } as unknown,
        },
        {
            name: "claim-name metadata slot",
            claims: { ...mapping, groups: "_claim_names" },
            idTokenClaims: { sub: "subject", _claim_names: "Staff" } as unknown,
        },
        {
            name: "claim-source metadata slot",
            claims: { ...mapping, groups: "_claim_sources" },
            idTokenClaims: { sub: "subject", _claim_sources: "Staff" } as unknown,
        },
        {
            name: "own __proto__ property",
            claims: { ...mapping, groups: "__proto__" },
            idTokenClaims: JSON.parse('{"sub":"subject","__proto__":"Staff"}') as unknown,
        },
        {
            name: "absent email-verification slot",
            claims: { ...mapping, groups: "email_verified" },
            idTokenClaims: { sub: "subject" } as unknown,
        },
    ])("round-trips supported group mapping collision: $name", ({ claims, idTokenClaims }) => {
        const normalized = normalizeOidcIdentityClaims({ idTokenClaims, claims });
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) return;

        const profile = createOidcIdentityProfile(normalized.value, claims);
        const jsonProfile = JSON.parse(JSON.stringify(profile)) as unknown;
        expect(normalizeOidcIdentityClaims({ idTokenClaims: jsonProfile, claims })).toEqual(normalized);
    });

    it("still rejects wrong-type group evidence in a colliding claim slot", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject", _claim_names: { unrelated: "source-1" } },
            claims: { ...mapping, groups: "_claim_names" },
        })).toEqual({ ok: false, error: "oidc_claims_invalid", reason: "groups_invalid" });
    });

    it("requires plain-record UserInfo with the exact ID-token subject", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "Case-Sensitive-Subject" },
            userInfo: { sub: "case-sensitive-subject" },
            claims: mapping,
        })).toEqual({ ok: false, error: "oidc_claims_invalid", reason: "userinfo_subject_mismatch" });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: " subject " },
            userInfo: { sub: "subject" },
            claims: mapping,
        })).toEqual({ ok: false, error: "oidc_claims_invalid", reason: "userinfo_subject_mismatch" });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: { sub: "subject" },
            userInfo: [],
            claims: mapping,
        })).toEqual({ ok: false, error: "oidc_claims_invalid", reason: "userinfo_invalid" });
    });

    it("supplements only presentation and eligibility claims from UserInfo", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "Case-Sensitive-Subject",
                iss: "https://issuer.example.test",
                aud: "client-id",
                nonce: "expected",
                login_name: "token-login",
                mail: "token@example.test",
                email_verified: false,
                roles: ["token-group"],
            },
            userInfo: {
                sub: "Case-Sensitive-Subject",
                iss: "https://attacker.example.test",
                aud: "attacker",
                nonce: "attacker",
                login_name: " UserInfo.Login ",
                mail: " UserInfo@Example.Test ",
                email_verified: true,
                roles: ["UserInfo-Group"],
            },
            claims: mapping,
        })).toEqual({
            ok: true,
            value: {
                subject: "Case-Sensitive-Subject",
                login: "userinfo.login",
                email: "userinfo@example.test",
                emailVerified: true,
                groups: ["userinfo-group"],
                groupsIncomplete: false,
            },
        });
    });

    it("does not carry ID-token email verification across a UserInfo email change", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "subject",
                mail: "old@outside.example",
                email_verified: true,
            },
            userInfo: {
                sub: "subject",
                mail: "new@allowed.example",
            },
            claims: mapping,
        })).toMatchObject({
            ok: true,
            value: {
                email: "new@allowed.example",
                emailVerified: false,
            },
        });
    });

    it("preserves ID-token verification when UserInfo repeats the same normalized email", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "Subject",
                mail: " Same@Example.Test ",
                email_verified: true,
            },
            userInfo: {
                sub: "Subject",
                mail: "same@example.test",
            },
            claims: mapping,
        })).toMatchObject({
            ok: true,
            value: {
                email: "same@example.test",
                emailVerified: true,
            },
        });

        expect(normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "Subject",
                mail: "same@example.test",
                email_verified: true,
            },
            userInfo: {
                sub: "Subject",
                mail: "same@example.test",
                email_verified: false,
            },
            claims: mapping,
        })).toMatchObject({
            ok: true,
            value: {
                email: "same@example.test",
                emailVerified: false,
            },
        });
    });

    it("does not apply UserInfo verification to an ID-token-selected mapped email", () => {
        expect(normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "subject",
                mail: "unverified@allowed.test",
                email_verified: false,
            },
            userInfo: {
                sub: "subject",
                email: "verified@outside.test",
                email_verified: true,
            },
            claims: mapping,
        })).toMatchObject({
            ok: true,
            value: {
                email: "unverified@allowed.test",
                emailVerified: false,
            },
        });
    });

    it("creates a bounded profile that the same normalizer can read", () => {
        const normalized = normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "subject",
                login_name: "Alice",
                mail: "Alice@Example.Test",
                email_verified: true,
                roles: ["Engineering", "Sales"],
            },
            claims: mapping,
        });
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) return;

        const profile = createOidcIdentityProfile(normalized.value, mapping);
        expect(profile).toEqual({
            sub: "subject",
            login_name: "alice",
            mail: "alice@example.test",
            email_verified: true,
            roles: ["engineering", "sales"],
        });
        expect(normalizeOidcIdentityClaims({ idTokenClaims: profile, claims: mapping })).toEqual(normalized);
    });

    it("round-trips distinct login and email values when configured claim names overlap standard fields", () => {
        const overlappingMapping = { login: "email", email: "mail", groups: "groups" };
        const normalized = normalizeOidcIdentityClaims({
            idTokenClaims: {
                sub: "subject",
                email: "Login@Example.Test",
                mail: "Mailbox@Example.Test",
                email_verified: true,
            },
            claims: overlappingMapping,
        });
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) return;

        const profile = createOidcIdentityProfile(normalized.value, overlappingMapping);
        expect(normalizeOidcIdentityClaims({ idTokenClaims: profile, claims: overlappingMapping })).toEqual(normalized);
    });

    it.each([
        {
            claimName: "shared_claim",
            idTokenClaims: { sub: "subject", preferred_username: "Alice", email: "mailbox@example.test" },
        },
        {
            claimName: "preferred_username",
            idTokenClaims: { sub: "subject", upn: "Alice" },
        },
        {
            claimName: "email",
            idTokenClaims: { sub: "subject", preferred_username: "Alice" },
        },
    ])("round-trips supported shared login/email mapping $claimName without rejecting it", ({ claimName, idTokenClaims }) => {
        const sharedMapping = { login: claimName, email: claimName, groups: "groups" };
        const normalized = normalizeOidcIdentityClaims({ idTokenClaims, claims: sharedMapping });
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) return;

        const profile = createOidcIdentityProfile(normalized.value, sharedMapping);
        expect(normalizeOidcIdentityClaims({ idTokenClaims: profile, claims: sharedMapping })).toEqual(normalized);
    });

    it.each([
        {
            mapping: { login: "sub", email: "email", groups: "groups" },
            idTokenClaims: { sub: "CaseSensitiveSubject", email: "mailbox@example.test" },
        },
        {
            mapping: { login: "email_verified", email: "email", groups: "groups" },
            idTokenClaims: { sub: "subject", preferred_username: "User" },
        },
    ])("round-trips login mapping $mapping.login without corrupting structural claims", ({ mapping, idTokenClaims }) => {
        const normalized = normalizeOidcIdentityClaims({ idTokenClaims, claims: mapping });
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) return;

        const profile = createOidcIdentityProfile(normalized.value, mapping);
        expect(normalizeOidcIdentityClaims({ idTokenClaims: profile, claims: mapping })).toEqual(normalized);
    });

    it("round-trips an own __proto__ identity claim through JSON without changing fallback login", () => {
        const protoMapping = { login: "preferred_username", email: "__proto__", groups: "groups" };
        const idTokenClaims = JSON.parse('{"sub":"CaseSubject","__proto__":"Proto"}') as unknown;
        const normalized = normalizeOidcIdentityClaims({ idTokenClaims, claims: protoMapping });
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) return;

        const profile = createOidcIdentityProfile(normalized.value, protoMapping);
        const jsonProfile = JSON.parse(JSON.stringify(profile)) as unknown;
        expect(Object.prototype.hasOwnProperty.call(jsonProfile, "__proto__")).toBe(true);
        expect(normalizeOidcIdentityClaims({ idTokenClaims: jsonProfile, claims: protoMapping })).toEqual(normalized);
    });
});
