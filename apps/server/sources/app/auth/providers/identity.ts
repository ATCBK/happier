import type { Context } from "@/context";
import { db } from "@/storage/db";
import { unlinkIdentity } from "./accountIdentityLifecycle";
import { resolveAuthMethodIdForAccountIdentityProvider } from "@/app/auth/methods/registry";
import type { PreparedIdentityConnection } from "./identityProviders/types";
import { resolveIdentityRuntimeById, resolveRuntime } from "./identityProviderCatalog";
import type { ProviderReference } from "./providerReference";

type ExternalIdentityConnectionParams = {
    providerId: string;
    /**
     * The provider reference bound when the OAuth attempt started, when the caller has one. The
     * identity leaf is then resolved by re-proving that reference, so an instance that changed,
     * moved context, or disappeared between authorization and this mutation cannot complete the
     * link.
     *
     * It is absent for supported released attempts authored before the binding existed and for
     * non-OAuth callers; those resolve the current instance by id exactly as before.
     */
    reference?: ProviderReference;
    ctx: Context;
    profile: unknown;
    accessToken: string;
    refreshToken?: string;
    preferredUsername?: string | null;
    usernamePolicyEnv?: NodeJS.ProcessEnv;
    transferFromAccountId?: string;
};

/**
 * Resolves the identity leaf of the exact bound provider runtime.
 *
 * Throws the catalog's typed code (`auth_provider_unavailable` or
 * `auth_provider_configuration_changed`) when the binding no longer holds, so no identity row is
 * written against a runtime the member never authorized.
 */
async function resolveBoundIdentityProvider(params: ExternalIdentityConnectionParams) {
    const providerId = params.providerId.toString().trim().toLowerCase();
    const reference = params.reference;
    if (!reference) {
        const provider = (await resolveIdentityRuntimeById(process.env, providerId))?.provider;
        if (!provider) throw new Error("unsupported-provider");
        return provider;
    }
    if (reference.id !== providerId) throw new Error("auth_provider_configuration_changed");

    const input = {
        env: process.env,
        reference,
        purpose: "oauth_finalize",
    } as const;
    const resolved = await resolveRuntime(input);
    if (!resolved.ok) throw new Error(resolved.code);
    if (!resolved.module.identity) throw new Error("unsupported-provider");
    return resolved.module.identity;
}

export async function prepareExternalIdentityConnection(
    params: ExternalIdentityConnectionParams,
): Promise<PreparedIdentityConnection> {
    const provider = await resolveBoundIdentityProvider(params);
    return await provider.prepareConnect({
        ctx: params.ctx,
        profile: params.profile,
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
        preferredUsername: params.preferredUsername,
        usernamePolicyEnv: params.usernamePolicyEnv,
        transferFromAccountId: params.transferFromAccountId,
    });
}

export async function disconnectExternalIdentity(params: { providerId: string; ctx: Context }): Promise<void> {
    const providerId = params.providerId.toString().trim().toLowerCase();
    const provider = (await resolveIdentityRuntimeById(process.env, providerId))?.provider;
    if (provider) return await provider.disconnect({ ctx: params.ctx });

    // Native AuthMethods own their own routes even when they persist an AccountIdentity row.
    if (resolveAuthMethodIdForAccountIdentityProvider(process.env, providerId) !== null) {
        throw new Error("unsupported-provider");
    }

    // A disabled or removed deployment runtime must not strand its existing Account identity.
    // The linked row is the authority for this mutation; lifecycle policy still rechecks every
    // required-Team and last-login blocker before deleting it.
    const linked = await db.accountIdentity.findFirst({
        where: { accountId: params.ctx.uid, provider: providerId },
        select: { id: true },
    });
    if (!linked) throw new Error("unsupported-provider");
    await unlinkIdentity({ accountId: params.ctx.uid, provider: providerId });
}
