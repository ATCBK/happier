import type { AuthProviderId } from '@happier-dev/protocol/auth/providers';
import { computeCanonicalDomainSeparatedDigest } from "@happier-dev/protocol/crypto/canonicalDigest";

import type { OAuthFlowProvider } from "@/app/oauth/providers/types";
import type { IdentityProvider } from "@/app/auth/providers/identityProviders/types";
import type { AuthProviderResolver } from "@/app/auth/providers/types";

import { githubProviderModule } from "@/app/auth/providers/github/providerModule";
import {
    resolveAuthProviderInstancesFromEnv,
    type OidcAuthProviderInstanceConfig,
} from "@/app/auth/providers/oidc/oidcProviderConfig";
import { createOidcProviderModule } from "@/app/auth/providers/oidc/oidcProviderModuleFactory";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";

export type ProviderModule = Readonly<{
    id: AuthProviderId;
    oauth?: OAuthFlowProvider;
    identity?: IdentityProvider;
    auth?: AuthProviderResolver;
}>;

const staticProviderModules: readonly ProviderModule[] = Object.freeze([
    githubProviderModule,
]);

export type DeploymentProviderSnapshot = Readonly<{
    modules: readonly ProviderModule[];
    errors: readonly string[];
    references: ReadonlyMap<AuthProviderId, DeploymentProviderRuntimeReference>;
    hasOidcAllowlistsConfigured: boolean;
}>;

export type DeploymentProviderRuntimeReference = Readonly<{
    source: "built_in" | "deployment";
    runtimeFingerprint: string;
}>;

function canonicalSet(values: readonly string[]): string {
    return JSON.stringify([...new Set(values)].sort());
}

function resolveDeploymentRuntimeFingerprint(instance: OidcAuthProviderInstanceConfig): string {
    const digest = computeCanonicalDomainSeparatedDigest(
        "happier.auth.deployment-provider-runtime.v1",
        [
            instance.id,
            instance.type,
            instance.issuer,
            instance.clientId,
            instance.clientSecret,
            instance.clientAuthenticationMethod,
            instance.redirectUrl,
            canonicalSet(instance.scopes.split(/\s+/g).filter(Boolean)),
            String(instance.httpTimeoutSeconds),
            instance.claims.login,
            instance.claims.email,
            instance.claims.groups,
            canonicalSet(instance.allow.usersAllowlist),
            canonicalSet(instance.allow.emailDomains),
            canonicalSet(instance.allow.groupsAny),
            canonicalSet(instance.allow.groupsAll),
            instance.fetchUserInfo ? "1" : "0",
            instance.storeRefreshToken ? "1" : "0",
            ...(instance.tokenExchange ? [
                canonicalSet(instance.tokenExchange.allowedClientIds),
                instance.tokenExchange.clientIdClaim ?? "",
                instance.tokenExchange.subjectClaim,
            ] : []),
        ],
    );
    return `deployment:v1:${digest}`;
}

export function resolveDeploymentProviderSnapshot(env: NodeJS.ProcessEnv): DeploymentProviderSnapshot {
    const oidc = resolveAuthProviderInstancesFromEnv(env);
    const references = new Map<AuthProviderId, DeploymentProviderRuntimeReference>(
        staticProviderModules.map((module) => [
            module.id,
            Object.freeze({
                source: "built_in",
                runtimeFingerprint: `builtin:${module.id}:v1`,
            }),
        ]),
    );

    const authMethods = resolveAuthMethodRegistry(env);
    const reservedIds = new Set([
        ...staticProviderModules.map((module) => module.id.trim().toLowerCase()),
        ...authMethods.map((module) => module.id.trim().toLowerCase()),
        ...authMethods.flatMap((module) => module.accountIdentityProviderId
            ? [module.accountIdentityProviderId.trim().toLowerCase()]
            : []),
        "anonymous",
    ]);
    const oidcModules: ProviderModule[] = [];
    const collisionErrors: string[] = [];
    let hasOidcAllowlistsConfigured = false;
    for (const instance of oidc.instances) {
        const id = instance.id.trim().toLowerCase();
        if (reservedIds.has(id)) {
            collisionErrors.push(
                `Provider id collision: ${id} is reserved by a static, core, or compatibility auth method`,
            );
            continue;
        }
        hasOidcAllowlistsConfigured ||=
            instance.allow.usersAllowlist.length > 0 ||
            instance.allow.emailDomains.length > 0 ||
            instance.allow.groupsAny.length > 0 ||
            instance.allow.groupsAll.length > 0;
        const reference = Object.freeze({
            source: "deployment",
            runtimeFingerprint: resolveDeploymentRuntimeFingerprint(instance),
        }) satisfies DeploymentProviderRuntimeReference;
        references.set(instance.id, reference);
        oidcModules.push(createOidcProviderModule(instance, reference.runtimeFingerprint));
    }

    return Object.freeze({
        modules: Object.freeze([...staticProviderModules, ...oidcModules]),
        errors: Object.freeze([...oidc.errors, ...collisionErrors]),
        references,
        hasOidcAllowlistsConfigured,
    });
}
