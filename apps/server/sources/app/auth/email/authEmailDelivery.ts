import type { NormalizedVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';

/**
 * The closed transactional-mail boundary for Lane 02 authentication messages.
 * It is deliberately not a notification bus, campaign system, template editor,
 * outbox, or exactly-once queue: the database mutation is the authority and
 * delivery is retryable by the owning product action.
 */
export interface AuthEmailDelivery {
    /**
     * Whether this delivery has a configured transport. Asynchronous because the composed Home
     * delivery resolves its configuration (Home settings over env) at the moment it is asked.
     */
    isReady(): Promise<boolean>;
    deliver(message: AuthEmailMessage): Promise<AuthEmailDeliveryResult>;
}

export type AuthEmailRecipient = NormalizedVerifiedEmail;

export type InvitationEmailV1 = Readonly<{
    kind: "invitation";
    to: AuthEmailRecipient;
    /** The canonical explicit-Home capability URL. The renderer derives the QR from these exact bytes. */
    joinUrl: string;
    homeName: string;
    teamName: string | null;
    inviterLabel: string | null;
    requestedRole: string | null;
    sharesSessionHistory: boolean;
    emailBound: boolean;
    expiresAt: Date;
}>;

export type NativeEmailVerificationV1 = Readonly<{
    kind: "native_email_verification";
    to: AuthEmailRecipient;
    verifyUrl: string;
    expiresAt: Date;
}>;

export type PlainPasswordResetV1 = Readonly<{
    kind: "plain_password_reset";
    to: AuthEmailRecipient;
    resetUrl: string;
    expiresAt: Date;
}>;

/** No bearer capable of decrypting or replacing an E2EE envelope is ever mailed. */
export type E2eePasswordRecoveryGuidanceV1 = Readonly<{
    kind: "e2ee_password_recovery_guidance";
    to: AuthEmailRecipient;
    recoveryEntryUrl: string;
}>;

export type AccountAuthenticationChangeV1 =
    | "password_connected"
    | "password_changed"
    | "password_removed"
    | "password_reset"
    | "sign_in_email_changed";

export type AccountAuthenticationChangedNoticeV1 = Readonly<{
    kind: "account_authentication_changed_notice";
    to: AuthEmailRecipient;
    change: AccountAuthenticationChangeV1;
    occurredAt: Date;
    /** Omitted when the Home cannot publish its canonical Security destination. */
    accountSecurityUrl?: string | null;
}>;

/**
 * The Home owner's "Send a test email" (`home.mailDelivery.test`): a fixed, non-actionable message
 * that proves the transport. It carries no link and no bearer.
 */
export type MailDeliveryTestV1 = Readonly<{
    kind: "mail_delivery_test";
    to: AuthEmailRecipient;
    homeName: string | null;
}>;

export type AuthEmailMessage =
    | MailDeliveryTestV1
    | InvitationEmailV1
    | NativeEmailVerificationV1
    | PlainPasswordResetV1
    | E2eePasswordRecoveryGuidanceV1
    | AccountAuthenticationChangedNoticeV1;

export type AuthEmailDeliveryFailureReason =
    | "not_configured"
    | "render_failed"
    | "transport_failed";

export type AuthEmailDeliveryResult =
    | Readonly<{ status: "sent" }>
    | Readonly<{ status: "failed"; reason: AuthEmailDeliveryFailureReason; detail: string }>;

/**
 * Diagnostics must never disclose whether an Account exists, so failures are
 * summarized by message kind and reason only. Recipients and URLs carry bearer
 * material and are excluded.
 */
export function describeAuthEmailDeliveryFailure(
    message: AuthEmailMessage,
    result: AuthEmailDeliveryResult,
): string {
    return result.status === "sent"
        ? `auth-email ${message.kind} sent`
        : `auth-email ${message.kind} failed (${result.reason})`;
}
