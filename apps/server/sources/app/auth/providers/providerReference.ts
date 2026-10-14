import { AuthProviderIdSchema, type AuthProviderId } from '@happier-dev/protocol/auth/providers';
import { z } from "zod";

/**
 * Exact provider context an identity-provider lookup was resolved in.
 *
 * Context limits database-managed visibility while preserving one global provider namespace.
 */
export type ProviderCatalogContext =
    | Readonly<{ kind: "home" }>
    | Readonly<{ kind: "team"; teamId: string }>;

export const HOME_PROVIDER_CONTEXT: ProviderCatalogContext = Object.freeze({ kind: "home" });

/**
 * Source that composed a provider runtime. Managed instances enter only through the canonical
 * database catalog source; callers never discover or register sources dynamically.
 */
export type ProviderSource = "built_in" | "deployment" | "managed";

/**
 * Stable identity of one resolved provider runtime.
 *
 * `runtimeFingerprint` is opaque to every caller: it is copied unchanged and compared for equality.
 * Callers never parse or interpret its components.
 */
export type ProviderReference = Readonly<{
    id: AuthProviderId;
    source: ProviderSource;
    runtimeFingerprint: string;
    context: ProviderCatalogContext;
}>;

/** Strict reader for the catalog reference stored in an OAuth attempt or pending record. */
export const ProviderReferenceSchema: z.ZodType<ProviderReference> = z.object({
    id: AuthProviderIdSchema,
    source: z.enum(["built_in", "deployment", "managed"]),
    runtimeFingerprint: z.string().min(1),
    context: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("home") }).strict(),
        z.object({ kind: z.literal("team"), teamId: z.string().min(1) }).strict(),
    ]),
}).strict();

/**
 * Closed internal guard describing which provider operation a runtime resolution serves. It is
 * distinct from the persisted OAuth-attempt purpose.
 */
export type ProviderRuntimePurpose =
    | "oauth_start"
    | "oauth_callback"
    | "oauth_finalize"
    | "identity_eligibility"
    | "identity_connection_test";

export function isSameProviderContext(a: ProviderCatalogContext, b: ProviderCatalogContext): boolean {
    return a.kind === b.kind && (a.kind === "home" || (b.kind === "team" && a.teamId === b.teamId));
}

/**
 * Reference equality used by every re-resolution comparison. A difference in any component means the
 * bound runtime is no longer the runtime that would execute now.
 */
export function isSameProviderReference(a: ProviderReference, b: ProviderReference): boolean {
    return (
        a.id === b.id
        && a.source === b.source
        && a.runtimeFingerprint === b.runtimeFingerprint
        && isSameProviderContext(a.context, b.context)
    );
}
