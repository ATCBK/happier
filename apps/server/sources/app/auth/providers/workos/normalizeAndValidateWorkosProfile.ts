import {
    ACCOUNT_IDENTITY_PROVIDER_LOGIN_MAX_CODE_UNITS,
    ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS,
} from "@/app/auth/providers/accountIdentityBounds";
import { readAccountNameFromLegacyProfileV1 } from "@happier-dev/protocol";

export interface WorkosIdentityBinding {
    organizationId: string;
    connectionId: string;
}

export interface NormalizedWorkosProfile {
    id: string;
    name?: string;
    idpId: string | null;
    organizationId: string;
    connectionId: string;
    email: string;
}

export type NormalizeWorkosProfileResult =
    | Readonly<{ ok: true; value: Readonly<NormalizedWorkosProfile> }>
    | Readonly<{
        ok: false;
        error: "invalid_profile" | "workos_organization_mismatch" | "workos_connection_mismatch";
    }>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function readBoundedOpaqueString(value: unknown, maxCodeUnits: number): string | null {
    if (typeof value !== "string") return null;
    if (!value.trim() || value.length > maxCodeUnits) return null;
    return value;
}

function readEmail(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const email = value.trim().toLowerCase();
    if (!email || email.length > ACCOUNT_IDENTITY_PROVIDER_LOGIN_MAX_CODE_UNITS) return null;
    if (!email) return null;
    const at = email.indexOf("@");
    if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return null;
    return email;
}

export function normalizeAndValidateWorkosProfile(input: Readonly<{
    profile: unknown;
    expectedBinding: Readonly<WorkosIdentityBinding>;
}>): NormalizeWorkosProfileResult {
    if (!isPlainRecord(input.profile)) return Object.freeze({ ok: false, error: "invalid_profile" });

    const id = readBoundedOpaqueString(input.profile.id, ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS);
    const email = readEmail(input.profile.email);
    if (!id || !email) return Object.freeze({ ok: false, error: "invalid_profile" });

    const organizationId = readBoundedOpaqueString(
        input.profile.organizationId,
        ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS,
    );
    if (organizationId !== input.expectedBinding.organizationId) {
        return Object.freeze({ ok: false, error: "workos_organization_mismatch" });
    }

    const connectionId = readBoundedOpaqueString(
        input.profile.connectionId,
        ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS,
    );
    if (connectionId !== input.expectedBinding.connectionId) {
        return Object.freeze({ ok: false, error: "workos_connection_mismatch" });
    }

    let idpId: string | null = null;
    if (input.profile.idpId !== undefined && input.profile.idpId !== null) {
        idpId = readBoundedOpaqueString(
            input.profile.idpId,
            ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS,
        );
        if (!idpId) return Object.freeze({ ok: false, error: "invalid_profile" });
    }

    const fullName = typeof input.profile.name === "string" ? input.profile.name.trim() : "";
    // Provider-part names are joined at ingress only; Account display never splits a name.
    const name = readAccountNameFromLegacyProfileV1({
        name: fullName || undefined,
        firstName: typeof input.profile.firstName === "string" ? input.profile.firstName : null,
        lastName: typeof input.profile.lastName === "string" ? input.profile.lastName : null,
    });
    return Object.freeze({
        ok: true,
        value: Object.freeze({ id, idpId, organizationId, connectionId, email, ...(name ? { name } : {}) }),
    });
}
