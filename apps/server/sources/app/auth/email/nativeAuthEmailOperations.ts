import { NATIVE_AUTH_EMAIL_VERIFY_APP_PATH_V1, NATIVE_AUTH_PASSWORD_RECOVERY_APP_PATH_V1, NATIVE_AUTH_PASSWORD_RESET_APP_PATH_V1 } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { type NormalizedVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { type NativeAuthOneTimeOperationV1 } from '@happier-dev/protocol/auth/nativeAuthOneTimeOperation';

import { inTx } from "@/storage/inTx";
import type {
    AccountAuthenticationChangeV1,
    AuthEmailDelivery,
    AuthEmailDeliveryResult,
    AuthEmailMessage,
} from "./authEmailDelivery";
import { issueNativeAuthOneTimeOperationInTx } from "./nativeAuthOneTimeOperations";
import { warn } from "@/utils/logging/log";

export type AuthEmailApplicationLinkTarget = Readonly<{
    applicationOrigin: string | null;
    /** Opaque non-secret carrier produced by Homes. Lane 02 never parses or invents it. */
    homeTarget: string | null;
    /** Stable Home identity consumed by Home-scoped authenticated application routes. */
    serverId: string | null;
}>;

/**
 * Resolves where mail links open. `env` is the Home-effective configuration when the caller already
 * holds it (for example inside a transaction, where a second Home-settings read would wait on the
 * transaction's own SQLite connection); without it the resolver reads the Home's configuration.
 */
export type ResolveAuthEmailApplicationLinkTarget = (
    env?: Readonly<Record<string, string | undefined>>,
) => Promise<AuthEmailApplicationLinkTarget>;

/**
 * The raw bearer belongs only in the canonical URL path, never a query
 * parameter, so it does not leak through referrers, proxies, or access logs.
 */
function buildApplicationUrl(
    target: AuthEmailApplicationLinkTarget,
    path: string,
    query: "target" | "serverId" = "target",
): string | null {
    const queryValue = query === "target" ? target.homeTarget : target.serverId;
    if (target.applicationOrigin === null || queryValue === null) return null;
    try {
        const origin = new URL(target.applicationOrigin);
        if ((origin.protocol !== "https:" && origin.protocol !== "http:")
            || origin.username || origin.password || origin.search || origin.hash) return null;
        const base = `${origin.origin}${origin.pathname.replace(/\/+$/, "")}`;
        const url = new URL(`${base}${path}`);
        url.searchParams.set(query, queryValue);
        return url.toString();
    } catch {
        return null;
    }
}

export function buildNativeEmailVerifyUrl(
    target: AuthEmailApplicationLinkTarget,
    rawBearer: string,
    purpose?: "account_service",
): string | null {
    const url = buildApplicationUrl(target, `${NATIVE_AUTH_EMAIL_VERIFY_APP_PATH_V1}/${rawBearer}`);
    if (url === null || purpose === undefined) return url;
    // A non-secret journey marker: the landing finishes account-service sign-in instead of Home
    // sign-in. Creation still re-checks every admission and capability on the server.
    const marked = new URL(url);
    marked.searchParams.set("purpose", purpose);
    return marked.toString();
}

/**
 * Whether mail links can be built for this Home right now: the same facts every mailed link is
 * rendered from (an application origin and the portable Home target). Readiness reads this so it
 * can never advertise a mail action whose link the send path would refuse to render.
 */
export function isAuthEmailApplicationLinkBuildable(target: AuthEmailApplicationLinkTarget): boolean {
    return buildNativeEmailVerifyUrl(target, "readiness") !== null
        && buildApplicationUrl(target, "/readiness", "serverId") !== null;
}

export function buildPlainPasswordResetUrl(target: AuthEmailApplicationLinkTarget, rawBearer: string): string | null {
    return buildApplicationUrl(target, `${NATIVE_AUTH_PASSWORD_RESET_APP_PATH_V1}/${rawBearer}`);
}

export function buildE2eePasswordRecoveryUrl(target: AuthEmailApplicationLinkTarget): string | null {
    return buildApplicationUrl(target, NATIVE_AUTH_PASSWORD_RECOVERY_APP_PATH_V1);
}

export type NativeAuthEmailRequestOutcome =
    | Readonly<{ status: "unavailable" }>
    | Readonly<{ status: "delivered"; delivery: AuthEmailDeliveryResult }>;

export type NativeAuthEmailDeps = Readonly<{
    delivery: AuthEmailDelivery;
    resolveApplicationLinkTarget: ResolveAuthEmailApplicationLinkTarget;
}>;

async function deliverAuthEmail(
    delivery: AuthEmailDelivery,
    message: AuthEmailMessage,
): Promise<AuthEmailDeliveryResult> {
    let result: AuthEmailDeliveryResult;
    try {
        result = await delivery.deliver(message);
    } catch {
        // The adapter contract is typed, but a third-party transport boundary
        // may still throw. Keep post-commit security notices best-effort and
        // keep public request routes on their existing typed failure path.
        result = {
            status: "failed",
            reason: "transport_failed",
            detail: "Authentication email delivery threw",
        };
    }
    if (result.status === "failed") {
        // Never include recipient, URL/bearer, or provider detail: public request
        // routes deliberately preserve Account-existence neutrality.
        warn({
            module: "auth-email",
            messageKind: message.kind,
            reason: result.reason,
        }, "Authentication email delivery failed");
    }
    return result;
}

/**
 * Creates and mails a native email-verification operation.
 *
 * The operation is persisted and committed before delivery is attempted, so a
 * transport failure never leaves a link that was never recorded, and a caller
 * may simply request a new operation instead of resending a stored bearer.
 */
export async function requestNativeEmailVerification(
    deps: NativeAuthEmailDeps,
    params: Readonly<{
        recipient: NormalizedVerifiedEmail;
        consumer: Extract<NativeAuthOneTimeOperationV1, { purpose: "verify_native_email" }>["consumer"];
        /** Set only by a server that is an account service, for account-service creation. */
        linkPurpose?: "account_service";
    }>,
): Promise<NativeAuthEmailRequestOutcome> {
    const target = await deps.resolveApplicationLinkTarget();
    if (buildNativeEmailVerifyUrl(target, "readiness") === null) return { status: "unavailable" };
    const issued = await inTx(async (tx) => issueNativeAuthOneTimeOperationInTx(tx, {
        v: 1,
        purpose: "verify_native_email",
        normalizedEmail: params.recipient.normalizedEmail,
        consumer: params.consumer,
    }));
    const verifyUrl = buildNativeEmailVerifyUrl(target, issued.rawBearer, params.linkPurpose);
    if (verifyUrl === null) return { status: "unavailable" };

    const delivery = await deliverAuthEmail(deps.delivery, {
        kind: "native_email_verification",
        to: params.recipient,
        verifyUrl,
        expiresAt: issued.expiresAt,
    });
    return { status: "delivered", delivery };
}

/**
 * Creates and mails a Plain password-reset operation. The credential revision
 * and native sign-in identity lifetime/address are bound here; the owning reset
 * transaction rechecks them when it consumes the operation. Password change,
 * email change, and removal/re-enrollment leave old links inert.
 */
export async function requestPlainPasswordReset(
    deps: NativeAuthEmailDeps,
    params: Readonly<{
        recipient: NormalizedVerifiedEmail;
        accountId: string;
        credentialRevision: number;
        nativeIdentityId: string;
        expectedNativeIdentity: string;
    }>,
): Promise<NativeAuthEmailRequestOutcome> {
    const target = await deps.resolveApplicationLinkTarget();
    if (buildPlainPasswordResetUrl(target, "readiness") === null) return { status: "unavailable" };
    const issued = await inTx(async (tx) => issueNativeAuthOneTimeOperationInTx(tx, {
        v: 1,
        purpose: "reset_plain_password",
        accountId: params.accountId,
        credentialRevision: params.credentialRevision,
        nativeIdentityId: params.nativeIdentityId,
        expectedNativeIdentity: params.expectedNativeIdentity,
    }));
    const resetUrl = buildPlainPasswordResetUrl(target, issued.rawBearer);
    if (resetUrl === null) return { status: "unavailable" };

    const delivery = await deliverAuthEmail(deps.delivery, {
        kind: "plain_password_reset",
        to: params.recipient,
        resetUrl,
        expiresAt: issued.expiresAt,
    });
    return { status: "delivered", delivery };
}

/**
 * An eligible E2EE Account receives recovery guidance rather than a reset
 * bearer: email alone can never restore end-to-end encrypted content.
 */
export async function sendE2eePasswordRecoveryGuidance(
    deps: NativeAuthEmailDeps,
    params: Readonly<{ recipient: NormalizedVerifiedEmail }>,
): Promise<AuthEmailDeliveryResult> {
    const recoveryEntryUrl = buildE2eePasswordRecoveryUrl(await deps.resolveApplicationLinkTarget());
    if (recoveryEntryUrl === null) {
        return { status: "failed", reason: "render_failed", detail: "Home application link unavailable" };
    }
    return await deliverAuthEmail(deps.delivery, {
        kind: "e2ee_password_recovery_guidance",
        to: params.recipient,
        recoveryEntryUrl,
    });
}

export async function sendAccountAuthenticationChangedNotice(
    deps: Readonly<{
        delivery: AuthEmailDelivery;
        resolveApplicationLinkTarget: ResolveAuthEmailApplicationLinkTarget;
    }>,
    params: Readonly<{
        recipient: NormalizedVerifiedEmail;
        change: AccountAuthenticationChangeV1;
        occurredAt: Date;
        /** Prepared by the Homes application-link owner; never inferred from ambient focus or request Host. */
        accountSecurityUrl?: string | null;
    }>,
): Promise<AuthEmailDeliveryResult> {
    let accountSecurityUrl = params.accountSecurityUrl;
    if (accountSecurityUrl === undefined) {
        try {
            accountSecurityUrl = buildApplicationUrl(
                await deps.resolveApplicationLinkTarget(),
                "/settings/account/security",
                "serverId",
            );
        } catch {
            // The destination is optional notice affordance. A Homes discovery
            // outage must not suppress a post-commit security notification.
            accountSecurityUrl = null;
        }
    }
    return await deliverAuthEmail(deps.delivery, {
        kind: "account_authentication_changed_notice",
        to: params.recipient,
        change: params.change,
        occurredAt: params.occurredAt,
        accountSecurityUrl,
    });
}
