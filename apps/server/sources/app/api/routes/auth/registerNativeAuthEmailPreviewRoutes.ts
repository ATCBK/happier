import { maskEmailForNativeAuthPreview } from '@happier-dev/protocol/auth/nativeAuthOneTimeOperation';
import { NATIVE_AUTH_EMAIL_VERIFY_REQUEST_PATH_V1, NATIVE_AUTH_EMAIL_VERIFY_PREVIEW_PATH_V1, NATIVE_AUTH_PASSWORD_RESET_REQUEST_PATH_V1, NATIVE_AUTH_PASSWORD_RESET_PREVIEW_PATH_V1, NativeAuthEmailAcceptedResponseV1Schema, NativeAuthBearerPreviewRequestV1Schema, NativeEmailVerifyRequestV1Schema, NativeEmailVerifyPreviewResponseV1Schema, NativePasswordResetRequestV1Schema, NativePasswordResetPreviewResponseV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { parseAccountPasswordCredentialV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';

import { inTx } from "@/storage/inTx";
import { readNativeAuthOneTimeOperation } from "@/app/auth/email/nativeAuthOneTimeOperations";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { type Fastify } from "../../types";
import type { AuthEmailDelivery } from "@/app/auth/email/authEmailDelivery";
import {
    requestNativeEmailVerification,
    requestPlainPasswordReset,
    sendE2eePasswordRecoveryGuidance,
} from "@/app/auth/email/nativeAuthEmailOperations";
import type { ResolveAuthEmailApplicationLinkTarget } from "@/app/auth/email/nativeAuthEmailOperations";
import {
    isEffectiveHomeAuthMethodActionEnabledInTx,
    resolveEffectiveHomeAuthMethods,
    resolveEffectiveHomeAuthMethodsInTx,
} from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveTeamInvitationMailboxVerificationAdmissionInTx } from "@/app/teams/invitations/freshAccountAdmission";
import { isAccountDirectoryServiceEnabled } from "@/app/features/accountDirectoryFeature";
import { loadValidFreshAccountAuthContinuation } from "@/app/api/routes/connect/connectRoutes.oauthPending";

const NO_REFERRER_HEADER = "Referrer-Policy";
const NO_REFERRER_VALUE = "no-referrer";

/**
 * Preview is strictly read-only. A security scanner, mail prefetcher, or
 * browser refresh may open these paths any number of times without consuming
 * the operation, creating an Account, or writing mailbox evidence. Expired,
 * missing, malformed, wrong-purpose, and already-consumed bearers are all
 * reported identically as invalid.
 */
export function registerNativeAuthEmailOperationRoutes(
    app: Fastify,
    deps: Readonly<{
        delivery: AuthEmailDelivery;
        isDeliveryReady: () => boolean | Promise<boolean>;
        env: NodeJS.ProcessEnv;
        resolveApplicationLinkTarget: ResolveAuthEmailApplicationLinkTarget;
    }>,
): void {
    app.post(NATIVE_AUTH_EMAIL_VERIFY_REQUEST_PATH_V1, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(deps.env, "auth.email.verify.request") },
        schema: {
            body: NativeEmailVerifyRequestV1Schema,
            response: { 200: NativeAuthEmailAcceptedResponseV1Schema },
        },
    }, async (request, reply) => {
        reply.header(NO_REFERRER_HEADER, NO_REFERRER_VALUE);
        const recipient = normalizeVerifiedEmail(request.body.email);
        const emailDeliveryReady = recipient ? await deps.isDeliveryReady() : false;
        const invitation = recipient && emailDeliveryReady && request.body.admission
            ? await inTx(async (tx) => {
                const resolved = await resolveTeamInvitationMailboxVerificationAdmissionInTx(tx, {
                    token: request.body.admission!.token,
                });
                if (!resolved) return null;
                const methods = await resolveEffectiveHomeAuthMethodsInTx(tx, {
                    env: deps.env,
                    emailDeliveryReady,
                    admission: { kind: "team_invitation" },
                });
                return { resolved, methods };
            })
            : null;
        const methods = recipient && emailDeliveryReady
            ? request.body.admission ? invitation?.methods ?? null
                : await resolveEffectiveHomeAuthMethods({ env: deps.env, emailDeliveryReady })
            : null;
        const continuation = recipient && !request.body.admission && request.body.continuationId
            ? await loadValidFreshAccountAuthContinuation(request.body.continuationId)
            : null;
        const provisionEnabled = methods?.status === "ready" && methods.decisions.some((decision) =>
            decision.id === "email_password"
            && decision.actions.some((action) => action.id === "provision" && action.enabled));
        const continuationAccepted = request.body.continuationId === undefined || continuation !== null;
        if (recipient && provisionEnabled && continuationAccepted) {
            await requestNativeEmailVerification({ delivery: deps.delivery, resolveApplicationLinkTarget: deps.resolveApplicationLinkTarget }, {
                recipient,
                consumer: invitation
                    ? {
                        kind: "team_invitation",
                        invitationId: invitation.resolved.invitationId,
                        tokenHash: invitation.resolved.tokenHash,
                        teamId: invitation.resolved.teamId,
                    }
                    : { kind: "fresh_account", continuationId: continuation?.key ?? null },
                // Only a fresh account on an account service can be an account-service sign-in.
                ...(request.body.purpose === "account_service" && !invitation
                    && isAccountDirectoryServiceEnabled(deps.env)
                    ? { linkPurpose: "account_service" as const }
                    : {}),
            });
        }
        return reply.send({ accepted: true });
    });

    app.post(NATIVE_AUTH_PASSWORD_RESET_REQUEST_PATH_V1, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(deps.env, "auth.password.reset.request") },
        schema: {
            body: NativePasswordResetRequestV1Schema,
            response: { 200: NativeAuthEmailAcceptedResponseV1Schema },
        },
    }, async (request, reply) => {
        reply.header(NO_REFERRER_HEADER, NO_REFERRER_VALUE);
        const recipient = normalizeVerifiedEmail(request.body.email);
        if (recipient && await deps.isDeliveryReady()) {
            const eligible = await inTx(async (tx) => {
                if (!await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                    env: deps.env,
                    methodId: "email_password",
                    actionId: "login",
                })) return null;
                const identity = await tx.accountIdentity.findUnique({
                    where: {
                        provider_providerUserId: {
                            provider: "email",
                            providerUserId: recipient.normalizedEmail,
                        },
                    },
                    select: {
                        id: true,
                        providerUserId: true,
                        account: {
                            select: {
                                id: true,
                                status: true,
                                encryptionMode: true,
                                AccountPasswordCredential: { select: { revision: true, credential: true } },
                            },
                        },
                    },
                });
                if (!identity || identity.account.status !== "active" || !identity.account.AccountPasswordCredential) return null;
                if (identity.account.encryptionMode !== "plain" && identity.account.encryptionMode !== "e2ee") return null;
                const parsed = parseAccountPasswordCredentialV1(
                    identity.account.encryptionMode,
                    identity.account.AccountPasswordCredential.credential,
                );
                if (!parsed.ok) return null;
                return {
                    accountId: identity.account.id,
                    identity: identity.providerUserId,
                    nativeIdentityId: identity.id,
                    revision: identity.account.AccountPasswordCredential.revision,
                    mode: parsed.mode,
                } as const;
            });
            if (eligible?.mode === "plain") {
                await requestPlainPasswordReset({ delivery: deps.delivery, resolveApplicationLinkTarget: deps.resolveApplicationLinkTarget }, {
                    recipient,
                    accountId: eligible.accountId,
                    credentialRevision: eligible.revision,
                    nativeIdentityId: eligible.nativeIdentityId,
                    expectedNativeIdentity: eligible.identity,
                });
            } else if (eligible?.mode === "e2ee") {
                await sendE2eePasswordRecoveryGuidance({ delivery: deps.delivery, resolveApplicationLinkTarget: deps.resolveApplicationLinkTarget }, { recipient });
            }
        }
        return reply.send({ accepted: true });
    });

    app.post(NATIVE_AUTH_EMAIL_VERIFY_PREVIEW_PATH_V1, {
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(deps.env, "auth.email.verify.preview"),
        },
        schema: {
            body: NativeAuthBearerPreviewRequestV1Schema,
            response: { 200: NativeEmailVerifyPreviewResponseV1Schema },
        },
    }, async (request, reply) => {
        reply.header(NO_REFERRER_HEADER, NO_REFERRER_VALUE);
        const operation = await inTx(async (tx) => await readNativeAuthOneTimeOperation(tx, {
            purpose: "verify_native_email",
            token: request.body.token,
        }));
        if (operation?.purpose !== "verify_native_email") {
            return reply.send({ v: 1, valid: false, maskedDestination: null, continuation: null });
        }
        return reply.send({
            v: 1,
            valid: true,
            maskedDestination: maskEmailForNativeAuthPreview(operation.normalizedEmail),
            continuation: operation.consumer.kind === "sign_in_email_change"
                ? "sign_in_email_change"
                : operation.consumer.kind === "password_enrollment"
                    ? "password_enrollment"
                    : operation.consumer.kind === "fresh_account" || operation.consumer.kind === "team_invitation"
                        ? "account_admission"
                        : "none",
        });
    });

    app.post(NATIVE_AUTH_PASSWORD_RESET_PREVIEW_PATH_V1, {
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(deps.env, "auth.password.reset.preview"),
        },
        schema: {
            body: NativeAuthBearerPreviewRequestV1Schema,
            response: { 200: NativePasswordResetPreviewResponseV1Schema },
        },
    }, async (request, reply) => {
        reply.header(NO_REFERRER_HEADER, NO_REFERRER_VALUE);
        // Reset preview discloses validity only. The destination mailbox is
        // already known to whoever opened the link, and echoing any Account
        // fact here would weaken the generic request response.
        const operation = await inTx(async (tx) => await readNativeAuthOneTimeOperation(tx, {
            purpose: "reset_plain_password",
            token: request.body.token,
        }));
        return reply.send({ v: 1, valid: operation?.purpose === "reset_plain_password" });
    });
}
