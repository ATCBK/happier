import * as oidcClient from "openid-client";

import type { OAuthFlowProvider, OAuthTokenExchangeResult } from "@/app/oauth/providers/types";
import type { OidcAuthProviderInstanceConfig } from "@/app/auth/providers/oidc/oidcProviderConfig";
import {
    createOidcIdentityProfile,
    normalizeOidcIdentityClaims,
} from "@/app/auth/providers/oidc/normalizeOidcIdentityClaims";
import { discoverOidcConfiguration } from "./oidcDiscovery";
import { createOidcExternalAccessTokenVerifier } from "./oidcExternalAccessTokenVerifier";
import type { OutboundIdentityNetworkPolicy } from "@/app/net/outboundIdentityNetworkPolicy";
import { evaluateOidcIdentityEligibility } from "@/app/auth/providers/oidc/oidcEligibility";
import type { OidcTeamIdentityConnection } from "@/app/auth/providers/oidc/oidcIdentityProvider";

export function createOidcOAuthProvider(
    instance: OidcAuthProviderInstanceConfig,
    runtimeFingerprint: string,
    networkPolicy?: OutboundIdentityNetworkPolicy,
    teamConnection?: OidcTeamIdentityConnection,
): OAuthFlowProvider {
    const isConfigured = () => Boolean(instance.clientId && instance.clientSecret && instance.redirectUrl && instance.issuer);
    const configured = isConfigured();

    const provider: OAuthFlowProvider = Object.freeze({
        id: instance.id,
        resolveStatus: () => ({ enabled: true, configured }),
        isConfigured: () => configured,
        resolveRedirectUrl: () => instance.redirectUrl,
        resolveScope: () => instance.scopes,
        validateConfiguration: async () => {
            if (!configured) throw new Error("oauth_not_configured");
            await discoverOidcConfiguration(instance, runtimeFingerprint, networkPolicy);
        },
        resolveAuthorizeUrl: async ({ state, scope, codeChallenge, codeChallengeMethod, nonce }) => {
            if (!instance.clientId || !instance.clientSecret || !instance.redirectUrl || !instance.issuer) {
                throw new Error("oauth_not_configured");
            }
            const cfg = await discoverOidcConfiguration(instance, runtimeFingerprint, networkPolicy);
            const url = oidcClient.buildAuthorizationUrl(cfg, {
                redirect_uri: instance.redirectUrl,
                scope,
                state,
                ...(codeChallenge && codeChallengeMethod
                    ? { code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod }
                    : {}),
                ...(nonce ? { nonce } : {}),
            });
            return url.toString();
        },
        exchangeCodeForAccessToken: async ({ code, state, iss, pkceCodeVerifier, expectedNonce }): Promise<OAuthTokenExchangeResult> => {
            if (!instance.clientId || !instance.clientSecret || !instance.redirectUrl || !instance.issuer) {
                throw new Error("oauth_not_configured");
            }
            const cfg = await discoverOidcConfiguration(instance, runtimeFingerprint, networkPolicy);
            const callbackUrl = new URL(instance.redirectUrl);
            callbackUrl.searchParams.set("code", code);
            if (typeof state === "string" && state) {
                callbackUrl.searchParams.set("state", state);
            }
            if (typeof iss === "string" && iss) {
                callbackUrl.searchParams.set("iss", iss);
            }

            const tokens = await oidcClient.authorizationCodeGrant(cfg, callbackUrl, {
                ...(typeof expectedNonce === "string" && expectedNonce ? { expectedNonce } : {}),
                ...(typeof state === "string" && state ? { expectedState: state } : {}),
                ...(typeof pkceCodeVerifier === "string" && pkceCodeVerifier ? { pkceCodeVerifier } : {}),
                idTokenExpected: true,
            });

            const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
            if (!accessToken) {
                throw new Error("missing_access_token");
            }
            const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
            const idTokenClaims = tokens.claims?.() ?? undefined;
            const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;

            return { accessToken, idToken, idTokenClaims, refreshToken };
        },
        fetchProfile: async ({ env: _env, accessToken, idTokenClaims }) => {
            const idTokenResult = normalizeOidcIdentityClaims({
                idTokenClaims,
                claims: instance.claims,
            });
            if (!idTokenResult.ok) throw new Error(idTokenResult.error);

            if (!instance.fetchUserInfo) {
                return createOidcIdentityProfile(idTokenResult.value, instance.claims);
            }

            const cfg = await discoverOidcConfiguration(instance, runtimeFingerprint, networkPolicy);
            try {
                const userInfo = await oidcClient.fetchUserInfo(cfg, accessToken, oidcClient.skipSubjectCheck);
                const result = normalizeOidcIdentityClaims({
                    idTokenClaims,
                    userInfo,
                    claims: instance.claims,
                });
                if (!result.ok) throw new Error(result.error);
                return createOidcIdentityProfile(result.value, instance.claims);
            } catch (err) {
                throw new Error("profile_fetch_failed", { cause: err });
            }
        },
        getLogin: (profile) => {
            const result = normalizeOidcIdentityClaims({ idTokenClaims: profile, claims: instance.claims });
            return result.ok ? result.value.login : null;
        },
        getProviderUserId: (profile) => {
            const result = normalizeOidcIdentityClaims({ idTokenClaims: profile, claims: instance.claims });
            return result.ok ? result.value.subject : null;
        },
        ...(instance.tokenExchange ? {
            verifyExternalAccessToken: createOidcExternalAccessTokenVerifier(instance, instance.tokenExchange, runtimeFingerprint, networkPolicy),
        } : {}),
        describeIdentityTest: async ({ profile }) => {
            const normalized = normalizeOidcIdentityClaims({ idTokenClaims: profile, claims: instance.claims });
            if (!normalized.ok) throw new Error(normalized.error);
            const claims = normalized.value;
            return {
                subjectPresent: Boolean(claims.subject),
                loginAvailable: claims.login !== null,
                emailAvailable: claims.email !== null,
                emailVerified: claims.emailVerified,
                groups: claims.groupsIncomplete
                    ? { state: "incomplete" }
                    : claims.groups === null
                        ? { state: "absent" }
                        : { state: "complete", values: claims.groups },
                // The same combined rules the Team's sign-in applies, so a Test can never
                // report `eligible` for a subject this connection would refuse.
                eligibility: evaluateOidcIdentityEligibility({
                    allow: instance.allow,
                    ...(teamConnection ? { additionalAllow: teamConnection.allow } : {}),
                    claims,
                }),
            };
        },
    });

    return provider;
}
