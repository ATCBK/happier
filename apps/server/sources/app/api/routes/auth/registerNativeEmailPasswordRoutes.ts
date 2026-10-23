import { AUTH_TOKEN_KIND_AUTHORITIES } from '@happier-dev/protocol/auth/authToken';
import { NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1, NativeEmailPasswordPreloginRequestV1Schema, NativeEmailPasswordPreloginResponseV1Schema, NATIVE_AUTH_EMAIL_LOGIN_PATH_V1, NativeEmailPasswordLoginRequestV1Schema, NativeEmailPasswordLoginResponseV1Schema, NativeEmailPasswordErrorResponseV1Schema, NATIVE_AUTH_EMAIL_UNLOCK_PATH_V1, NativeEmailPasswordUnlockRequestV1Schema, NativeEmailPasswordUnlockResponseV1Schema, NATIVE_AUTH_EMAIL_PROVISION_PATH_V1, NativeEmailPasswordProvisionRequestV1Schema, NativeEmailPasswordProvisionResponseV1Schema, NativeEmailPasswordProvisionErrorResponseV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { decodePasswordCredentialFieldV1, type AccountPasswordCredentialV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import type { Fastify } from "../../types";
import { registerNativePasswordStepUpRoutes } from "./registerNativePasswordStepUpRoutes";
import {
    isEffectiveHomeAuthMethodActionEnabled,
    isEffectiveHomeAuthMethodActionEnabledInTx,
} from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { loginWithNativePlainPassword, unlockNativeE2eePassword, preloginNativePassword } from "@/app/auth/password/nativePasswordAuthentication";
import { PasswordHashOverloadedError } from "@/app/auth/password/passwordHashAdmission";
import { registerAccountSecurityRoutes } from "./registerAccountSecurityRoutes";
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import {
    abortFreshAccountProvision,
    FreshAccountProvisionAbort,
    provisionFreshAccountInTx,
} from "@/app/auth/provisionFreshAccountInTx";
import { consumeNativeAuthOneTimeOperationInTx, readNativeAuthOneTimeOperation } from "@/app/auth/email/nativeAuthOneTimeOperations";
import { inTx } from "@/storage/inTx";
import {
    prepareE2eeAccountPasswordCredentialV1,
    preparePlainAccountPasswordCredentialV1,
} from "@/app/auth/password/accountPasswordCredentialPreparation";
import { randomUUID } from "node:crypto";
import { auth } from "@/app/auth/auth";
import * as privacyKit from "privacy-kit";
import { createKeyChallengeV2SigningInput } from '@happier-dev/protocol/auth/keyChallenge';
import { verifyAccountContentKeyBinding } from "@/app/encryption/accountContentKeyAdmission";
import { readKeyChallengeV2ForLogin, verifyKeyChallengeSignature, consumeLoginKeyChallengeV2 } from "@/app/auth/keyChallengeV2";
import { resolveEffectiveHomeAuthMethodsInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveTeamInvitationAuthEntryContextInTx } from "@/app/teams/invitations/invitationService";
import { TeamInvitationAcceptanceAbort } from "@/app/teams/invitations/accept";
import {
    requireTeamInvitationFreshAccountAdmissionInTx,
    requireTeamInvitationFreshAccountAdmissionReferenceInTx,
    resolveTeamInvitationMailboxVerificationAdmissionInTx,
    TeamInvitationFreshAccountAdmissionAbort,
} from "@/app/teams/invitations/freshAccountAdmission";
import { isTeamMembershipAdmissionEnabled } from "@/app/teams/memberships/membershipService";
import { acquireTeamMutationAccountAdmissionInTx } from "@/app/teams/memberships/sessionAccessEffects";
import { linkIdentityInTx, ProviderAlreadyLinkedError } from "@/app/auth/providers/accountIdentityLifecycle";
import { registerNativeAuthEmailOperationRoutes } from "./registerNativeAuthEmailPreviewRoutes";
import type { AuthEmailDelivery } from "@/app/auth/email/authEmailDelivery";
import { resolveAuthEmailReadiness } from "@/app/auth/email/resolveAuthEmailDelivery";
import { createHomeAuthEmailDelivery } from "@/app/auth/email/homeAuthEmailDelivery";
import { isPrismaUniqueConstraintError } from "@/storage/db";
import type { ResolveAuthEmailApplicationLinkTarget } from "@/app/auth/email/nativeAuthEmailOperations";
import { isE2eePasswordEnvelopeBoundToAccount } from "@/app/auth/password/e2eePasswordCredentialAccountBinding";
import { shouldDenyPublicSignupProvisioningAction } from "@/app/integrations/publicUrl/publicSignupProvisioningPolicy";
import { isAccountDirectoryServiceEnabled } from "@/app/features/accountDirectoryFeature";
import { prepareSameServiceHomeEntry } from "@/app/accountDirectory/accountDirectoryService";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

export function registerNativeEmailPasswordRoutes(app: Fastify, params: Readonly<{
    isEmailDeliveryReady?: () => boolean | Promise<boolean>;
    authEmailDelivery?: AuthEmailDelivery;
    resolveApplicationLinkTarget?: ResolveAuthEmailApplicationLinkTarget;
}> = {}): void {
    const authEmailDelivery = params.authEmailDelivery ?? createHomeAuthEmailDelivery();
    const resolveApplicationLinkTarget = params.resolveApplicationLinkTarget
        ?? (async () => ({ applicationOrigin: null, homeTarget: null, serverId: null }));
    const isEmailDeliveryReady = params.isEmailDeliveryReady
        ?? (async () => await resolveAuthEmailReadiness({ transportReady: await authEmailDelivery.isReady(), resolveApplicationLinkTarget }));
    // Fail before installing any part of this method when its authenticated
    // Account Security surface has no canonical bearer verifier.
    registerAccountSecurityRoutes(app, {
        authEmailDelivery,
        isEmailDeliveryReady,
        resolveApplicationLinkTarget,
    });
    registerNativeAuthEmailOperationRoutes(app, {
        delivery: authEmailDelivery,
        isDeliveryReady: isEmailDeliveryReady,
        env: process.env,
        resolveApplicationLinkTarget,
    });
    registerNativePasswordStepUpRoutes(app);
    const admitsRequestedProvisionMode = (
        methods: Awaited<ReturnType<typeof resolveEffectiveHomeAuthMethodsInTx>>,
        mode: "plain" | "e2ee",
    ): boolean => methods.status === "ready" && methods.decisions.some((decision) =>
        decision.id === "email_password" && decision.actions.some((action) =>
            action.id === "provision" && action.enabled
            && (action.mode === "either" || action.mode === (mode === "plain" ? "keyless" : "keyed"))));
    app.post(NATIVE_AUTH_EMAIL_PROVISION_PATH_V1, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.email.login") },
        schema: {
            body: NativeEmailPasswordProvisionRequestV1Schema,
            response: {
                200: NativeEmailPasswordProvisionResponseV1Schema,
                401: NativeEmailPasswordProvisionErrorResponseV1Schema,
                403: NativeEmailPasswordProvisionErrorResponseV1Schema,
                503: NativeEmailPasswordProvisionErrorResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const body = request.body;
        const requestIp = request.ip;
        const normalized = normalizeVerifiedEmail(body.email);
        if (!normalized || !body.account || !["plain", "e2ee"].includes(body.account.mode)) return reply.code(401).send({ error: "authentication_failed" });
        const directoryCredential = body.credentialTarget === "account_directory";
        if (directoryCredential && !isAccountDirectoryServiceEnabled(requestHomeEnv)) {
            return reply.code(403).send({ error: "method_not_available" });
        }
        // A new account-service Account on a server that is also its own Home gets that Home's
        // directory entry in the creating transaction, as the Key Challenge finalizer does.
        const sameServicePreparation = directoryCredential ? await prepareSameServiceHomeEntry({}) : null;
        if (sameServicePreparation?.status === "not_dual_role"
            && sameServicePreparation.reason === "server_identity_mismatch") {
            throw new Error("Same-service Home descriptor identity mismatch");
        }
        const admissionTargetsTeam = body.admission.kind === "team_invitation"
            || await inTx(async (tx) => {
                const operation = await readNativeAuthOneTimeOperation(tx, {
                    purpose: "verify_native_email",
                    token: body.admission.token,
                });
                return operation?.purpose === "verify_native_email"
                    && operation.consumer.kind === "team_invitation";
            });
        if (admissionTargetsTeam && !await isTeamMembershipAdmissionEnabled({ env: requestHomeEnv })) {
            return reply.code(403).send({ error: "method_not_available" });
        }
        let e2eeAdmission: { publicKeyHex: string; contentKeyBinding: ReturnType<typeof verifyAccountContentKeyBinding>; challengeId: string } | null = null;
        if (body.account.mode === "e2ee") {
            try {
                const proof = body.account.proof;
                const challenge = await readKeyChallengeV2ForLogin({ challengeId: proof.challengeId, purpose: "account", env: requestHomeEnv });
                if (!challenge) return reply.code(401).send({ error: "authentication_failed" });
                const publicKey = privacyKit.decodeBase64(proof.publicKey);
                const signature = privacyKit.decodeBase64(proof.signature);
                if (!await verifyKeyChallengeSignature(createKeyChallengeV2SigningInput({
                    challengeId: challenge.id,
                    nonce: challenge.nonce,
                    issuedAt: challenge.issuedAt.toISOString(),
                    expiresAt: challenge.expiresAt.toISOString(),
                    audience: { origin: challenge.audienceOrigin, serverIdentityId: challenge.audienceServerIdentityId },
                }), signature, publicKey)) return reply.code(401).send({ error: "authentication_failed" });
                const contentPublicKey = privacyKit.decodeBase64(proof.contentPublicKey);
                const contentPublicKeySig = privacyKit.decodeBase64(proof.contentPublicKeySig);
                const contentKeyBinding = verifyAccountContentKeyBinding({ accountSigningPublicKey: publicKey, contentPublicKey, contentPublicKeySignature: contentPublicKeySig });
                if (!contentKeyBinding) return reply.code(401).send({ error: "authentication_failed" });
                const envelope = body.account.envelope;
                if (!isE2eePasswordEnvelopeBoundToAccount(envelope, privacyKit.encodeHex(publicKey))) {
                    return reply.code(401).send({ error: "authentication_failed" });
                }
                e2eeAdmission = { publicKeyHex: privacyKit.encodeHex(publicKey), contentKeyBinding, challengeId: proof.challengeId };
            } catch { return reply.code(401).send({ error: "authentication_failed" }); }
        }
        let preparedPasswordCredential: AccountPasswordCredentialV1;
        try {
            const prepared = body.account.mode === "plain"
                ? await preparePlainAccountPasswordCredentialV1(body.account.password)
                : await prepareE2eeAccountPasswordCredentialV1({
                    envelope: body.account.envelope,
                    authKey: body.account.authKey,
                });
            if (!prepared.ok) return reply.code(401).send({ error: "authentication_failed" });
            preparedPasswordCredential = prepared.credential;
        } catch (error) {
            if (error instanceof PasswordHashOverloadedError) {
                return reply.code(503).send({ error: "password_hash_overloaded" });
            }
            throw error;
        }
        // Read once, outside the transaction: the link-target read is I/O.
        const emailDeliveryReady = await isEmailDeliveryReady();
        const result = await inTx(async (tx) => {
            let teamId: string | null = null;
            let nativeProofToken: string | null = null;
            let nativeProofOperation: Awaited<ReturnType<typeof readNativeAuthOneTimeOperation>> = null;
            if (body.admission.kind === "team_invitation") {
                const invitation = await resolveTeamInvitationAuthEntryContextInTx(tx, { token: body.admission.token });
                if (!invitation) return null;
                if (invitation.recipientEmailNormalized !== null
                    && invitation.recipientEmailNormalized !== normalized.normalizedEmail) {
                    return { error: "email_mismatch" as const };
                }
                if (invitation.recipientEmailNormalized === null && body.admission.emailVerificationToken === undefined) return null;
                if (invitation.recipientEmailNormalized === null) {
                    const boundedInvitation = await resolveTeamInvitationMailboxVerificationAdmissionInTx(tx, {
                        token: body.admission.token,
                    });
                    nativeProofToken = body.admission.emailVerificationToken ?? null;
                    nativeProofOperation = nativeProofToken
                        ? await readNativeAuthOneTimeOperation(tx, {
                            purpose: "verify_native_email",
                            token: nativeProofToken,
                        })
                        : null;
                    if (!boundedInvitation
                        || nativeProofOperation?.purpose !== "verify_native_email"
                        || nativeProofOperation.normalizedEmail !== normalized.normalizedEmail
                        || nativeProofOperation.consumer.kind !== "team_invitation"
                        || nativeProofOperation.consumer.invitationId !== boundedInvitation.invitationId
                        || nativeProofOperation.consumer.tokenHash !== boundedInvitation.tokenHash
                        || nativeProofOperation.consumer.teamId !== boundedInvitation.teamId) return null;
                }
                const methods = await resolveEffectiveHomeAuthMethodsInTx(tx, {
                    env: requestHomeEnv,
                    emailDeliveryReady,
                    admission: { kind: "team_invitation" },
                });
                if (methods.status !== "ready") return null;
                if (!admitsRequestedProvisionMode(methods, body.account.mode)) return null;
                teamId = invitation.team.teamId;
            } else if (body.admission.kind === "native_email_verification") {
                nativeProofToken = body.admission.token;
                nativeProofOperation = await readNativeAuthOneTimeOperation(tx, {
                    purpose: "verify_native_email",
                    token: nativeProofToken,
                });
                if (nativeProofOperation?.purpose !== "verify_native_email"
                    || nativeProofOperation.normalizedEmail !== normalized.normalizedEmail
                    || nativeProofOperation.consumer.kind === "password_enrollment"
                    || nativeProofOperation.consumer.kind === "sign_in_email_change") return null;
                const contextualAdmission = nativeProofOperation.consumer.kind === "team_invitation"
                    ? { kind: "team_invitation" as const }
                    : undefined;
                const methods = await resolveEffectiveHomeAuthMethodsInTx(tx, {
                    env: requestHomeEnv,
                    emailDeliveryReady,
                    ...(contextualAdmission ? { admission: contextualAdmission } : {}),
                });
                if (!admitsRequestedProvisionMode(methods, body.account.mode)) {
                    return { error: "method_not_available" as const };
                }
                if (nativeProofOperation.consumer.kind === "team_invitation") {
                    teamId = nativeProofOperation.consumer.teamId;
                } else if (shouldDenyPublicSignupProvisioningAction({
                    // Invitation admission is exempt from the public-signup
                    // restriction in every finalizer; ordinary self-service
                    // creation answers to it here exactly as the Key Challenge
                    // finalizer does.
                    env: requestHomeEnv,
                    requestIp,
                    methodId: "email_password",
                    mode: body.account.mode === "plain" ? "keyless" : "keyed",
                })) {
                    return { error: "method_not_available" as const };
                }
            } else return null;
            const operation = nativeProofOperation ?? (nativeProofToken
                ? await readNativeAuthOneTimeOperation(tx, { purpose: "verify_native_email", token: nativeProofToken })
                : null);
            if (body.admission.kind === "native_email_verification"
                || body.admission.emailVerificationToken !== undefined) {
                if (!operation || !("normalizedEmail" in operation) || operation.normalizedEmail !== normalized.normalizedEmail) return null;
            }
            const accountId = randomUUID();
            // Invitation acceptance publishes to the existing Team audience as
            // well as the prospective Account. Admit that complete cohort before
            // provisioning or consuming any proof; nested owners reuse it.
            const recheckInvitationAudience = teamId === null ? null
                : await acquireTeamMutationAccountAdmissionInTx(tx, {
                    teamId, accountIds: [accountId], affectedAccountIds: [accountId],
                    membershipChange: { kind: "teamMembership", teamId }, intent: "exclusive",
                });
            if (e2eeAdmission && !await consumeLoginKeyChallengeV2(tx, e2eeAdmission.challengeId)) {
                abortFreshAccountProvision("key_challenge_not_current");
            }
            const account = await provisionFreshAccountInTx(tx, {
                insertSemantics: { kind: "must_create", accountId },
                publicKey: e2eeAdmission?.publicKeyHex ?? null,
                encryptionMode: e2eeAdmission ? "e2ee" : "plain",
                ...(e2eeAdmission ? { contentKeyBinding: e2eeAdmission.contentKeyBinding } : {}),
                verifiedMailbox: normalized,
                ...(sameServicePreparation ? { directoryPreparation: sameServicePreparation } : {}),
            });
            await recheckInvitationAudience?.();
            await linkIdentityInTx(tx, {
                accountId: account.id,
                provider: "email",
                providerUserId: normalized.normalizedEmail,
                providerLogin: null,
                profile: {},
                showOnProfile: false,
            });
            await tx.accountPasswordCredential.create({
                data: { accountId: account.id, credential: preparedPasswordCredential },
            });
            if (nativeProofToken && !await consumeNativeAuthOneTimeOperationInTx(tx, {
                purpose: "verify_native_email",
                token: nativeProofToken,
            })) abortFreshAccountProvision("admission_consumed");
            if (body.admission.kind === "team_invitation") {
                const acceptedInvitation = await requireTeamInvitationFreshAccountAdmissionInTx(tx, {
                    token: body.admission.token,
                    accountId: account.id,
                });
                teamId = acceptedInvitation.teamId;
            } else if (operation?.purpose === "verify_native_email" && operation.consumer.kind === "team_invitation") {
                const acceptedInvitation = await requireTeamInvitationFreshAccountAdmissionReferenceInTx(tx, {
                    invitationId: operation.consumer.invitationId,
                    tokenHash: operation.consumer.tokenHash,
                    teamId: operation.consumer.teamId,
                    accountId: account.id,
                });
                teamId = acceptedInvitation.teamId;
            }
            const tokenKind = directoryCredential ? "account_directory"
                : body.credentialKind === "terminal" ? "terminal" : "account";
            const token = await auth.createTokenInTx(tx, account.id, undefined, {
                kind: tokenKind,
                authority: AUTH_TOKEN_KIND_AUTHORITIES[tokenKind],
                authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }],
            });
            return { accountId: account.id, teamId, token };
        }, { isolationLevel: "Serializable" /* Native provisioning composes Home policy, invitation admission, identity and directory writes. */ }).catch((error) => {
            if (error instanceof TeamInvitationAcceptanceAbort) return null;
            if (error instanceof TeamInvitationFreshAccountAdmissionAbort) return null;
            if (error instanceof FreshAccountProvisionAbort) return null;
            if (error instanceof ProviderAlreadyLinkedError) return null;
            if (isPrismaUniqueConstraintError(error)) return null;
            throw error;
        });
        if (!result) return reply.code(401).send({ error: "authentication_failed" });
        if (result.error !== undefined) {
            return reply.code(403).send({ error: result.error });
        }
        return reply.send({ token: result.token, accountId: result.accountId, teamId: result.teamId });
    });
    app.post(NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.email.prelogin") },
        schema: {
            body: NativeEmailPasswordPreloginRequestV1Schema,
            response: { 200: NativeEmailPasswordPreloginResponseV1Schema, 403: NativeEmailPasswordErrorResponseV1Schema },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (!await isEffectiveHomeAuthMethodActionEnabled({ env: requestHomeEnv, methodId: "email_password", actionId: "login" })) {
            return reply.code(403).send({ error: "method_not_available" });
        }
        return reply.send(await preloginNativePassword({ email: request.body.email, env: requestHomeEnv }));
    });
    app.post(NATIVE_AUTH_EMAIL_LOGIN_PATH_V1, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.email.login") },
        schema: {
            body: NativeEmailPasswordLoginRequestV1Schema,
            response: {
                200: NativeEmailPasswordLoginResponseV1Schema,
                401: NativeEmailPasswordErrorResponseV1Schema,
                403: NativeEmailPasswordErrorResponseV1Schema,
                503: NativeEmailPasswordErrorResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (!await isEffectiveHomeAuthMethodActionEnabled({ env: requestHomeEnv, methodId: "email_password", actionId: "login", mode: "keyless" })) {
            return reply.code(403).send({ error: "method_not_available" });
        }
        const { credentialTarget, credentialKind, ...credentials } = request.body;
        // The restricted account-service credential exists only where this server is one.
        if (credentialTarget === "account_directory" && !isAccountDirectoryServiceEnabled(requestHomeEnv)) {
            return reply.code(403).send({ error: "method_not_available" });
        }
        try {
            const result = await loginWithNativePlainPassword({
                ...credentials,
                tokenKind: credentialTarget === "account_directory" ? "account_directory"
                    : credentialKind === "terminal" ? "terminal" : "account",
                env: requestHomeEnv,
                admitInTx: async (tx) => await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                    env: requestHomeEnv,
                    methodId: "email_password",
                    actionId: "login",
                    mode: "keyless",
                }),
            });
            if (!result.ok) {
                if (result.error === "provider-required" && "provider" in result) {
                    return reply.code(result.statusCode).send({ error: result.error, provider: result.provider });
                }
                return reply.code(result.statusCode).send({ error: result.error });
            }
            return reply.send({ token: result.token });
        } catch (error) {
            if (error instanceof PasswordHashOverloadedError) return reply.code(503).send({ error: "password_hash_overloaded" });
            throw error;
        }
    });
    app.post(NATIVE_AUTH_EMAIL_UNLOCK_PATH_V1, {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.email.unlock") },
        schema: {
            body: NativeEmailPasswordUnlockRequestV1Schema,
            response: {
                200: NativeEmailPasswordUnlockResponseV1Schema,
                401: NativeEmailPasswordErrorResponseV1Schema,
                403: NativeEmailPasswordErrorResponseV1Schema,
                503: NativeEmailPasswordErrorResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (!await isEffectiveHomeAuthMethodActionEnabled({
            env: requestHomeEnv,
            methodId: "email_password",
            actionId: "login",
            mode: "keyed",
        })) {
            return reply.code(403).send({ error: "method_not_available" });
        }
        try {
            const result = await unlockNativeE2eePassword({
                email: request.body.email, authKey: decodePasswordCredentialFieldV1(request.body.authKey), env: requestHomeEnv,
                admitInTx: async (tx) => await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                    env: requestHomeEnv,
                    methodId: "email_password",
                    actionId: "login",
                    mode: "keyed",
                }),
            });
            if (!result.ok) {
                if (result.error === "provider-required" && "provider" in result) {
                    return reply.code(result.statusCode).send({ error: result.error, provider: result.provider });
                }
                return reply.code(result.statusCode).send({ error: result.error });
            }
            return reply.send({
                envelope: result.envelope, expectedAccountId: result.expectedAccountId,
                challenge: result.challenge,
            });
        } catch (error) {
            if (error instanceof PasswordHashOverloadedError) return reply.code(503).send({ error: "password_hash_overloaded" });
            throw error;
        }
    });
}
