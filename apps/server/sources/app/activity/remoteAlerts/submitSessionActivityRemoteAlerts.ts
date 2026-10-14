import { ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1, ActivityRemoteAlertV2Schema, resolveActivityRemoteAlertEventForPersonalEventV2, type ActivityRemoteAlertCommittedMessageV2, type ActivityRemoteAlertEventV2 } from '@happier-dev/protocol/push/activityRemoteAlert';
import { SESSION_CHANGED_WAKE_TYPE, SessionChangedWakeV1Schema } from '@happier-dev/protocol/push/sessionChangedWake';
import { resolveAccountRemoteAlertPolicyCurrentness, resolveRemoteAlertPolicyDecision } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import { resolveExpoNotificationSoundName, resolvePushNotificationAndroidChannelId } from '@happier-dev/protocol/push/pushNotificationActions';
import { shouldMuteMobileAlertsForComputerFocus } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { type SessionPersonalEventKindV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';

import { listSessionPersonalEventRecipients } from "@/app/session/personal/eventEligibility";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import type { CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import { hasExactCurrentPublisherAuthorityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { eventRouter } from '@/app/events/eventRouter';
import { inTx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";

import { sendAccountExpoPushMessages, type AccountPushDelivery } from "../accountPushTransport";

/**
 * Generic Happier copy for the OS-visible fallback.
 *
 * No Session title, author, or message text crosses the Home or the push
 * provider on this leg. The native consumer enriches the alert locally, within
 * the stricter of the submitted preview ceiling and its current local policy.
 */
const REMOTE_ALERT_FALLBACK_BODY: Record<ActivityRemoteAlertEventV2["type"], string> = {
    ready: "A session you follow is ready.",
    permission_request: "A session you follow needs permission.",
    user_action_request: "A session you follow needs your input.",
    assigned: "A session was assigned to you.",
    failed: "A session you follow failed.",
    cancelled: "A session you follow was cancelled.",
    human_message: "A session you follow has a new message.",
    message: "A session you follow has a new message.",
    discussion_mention: "You were mentioned in a session discussion.",
    source_unavailable: "A followed session source is unavailable.",
};

function resolveRemoteAlertFallbackBody(
    event: ActivityRemoteAlertEventV2,
    assignmentAutoFollowed: boolean | undefined,
): string {
    if (event.type === "assigned" && assignmentAutoFollowed === true) {
        return "Following because you were assigned.";
    }
    return REMOTE_ALERT_FALLBACK_BODY[event.type];
}

/**
 * What this leg does with one committed personal event.
 *
 * `personal_only` is a decision, not a gap: access "never creates tracking,
 * unread or notifications by itself" (`LANE-09-BRIEF.md:68` item 16), so a
 * direct share is a relevance fact at effective level `none` — it earns no
 * OS-visible alert and no content-free wake, and adding either would notify
 * about exactly the thing item 16 says access never notifies about.
 *
 * `no_alert_event` is the different, non-deliberate outcome: an alerting kind
 * whose committed producer this Home does not own, which submits nothing
 * because there is nothing valid to submit.
 */
export type SessionActivityRemoteAlertDisposition =
    | Readonly<{ kind: "alert"; event: ActivityRemoteAlertEventV2 }>
    | Readonly<{ kind: "personal_only" }>
    | Readonly<{ kind: "no_alert_event" }>;

const PERSONAL_ONLY_DISPOSITION: SessionActivityRemoteAlertDisposition = Object.freeze({ kind: "personal_only" as const });
const NO_ALERT_EVENT_DISPOSITION: SessionActivityRemoteAlertDisposition = Object.freeze({ kind: "no_alert_event" as const });

export function resolveSessionActivityRemoteAlertDisposition(
    event: SessionPersonalEventKindV1,
    committedMessage?: ActivityRemoteAlertCommittedMessageV2,
    committedTurnId?: string,
    committedRequestId?: string,
): SessionActivityRemoteAlertDisposition {
    if (event === "directly_shared") return PERSONAL_ONLY_DISPOSITION;
    const alertEvent = resolveActivityRemoteAlertEventForPersonalEventV2(
        event,
        committedMessage,
        committedTurnId,
        committedRequestId,
    );
    return alertEvent ? { kind: "alert", event: alertEvent } : NO_ALERT_EVENT_DISPOSITION;
}

export type SubmitSessionActivityRemoteAlertsParams = Readonly<{
    sessionId: string;
    event: SessionPersonalEventKindV1;
    /** Required for sequence-backed events: the committed sequence and its canonical owner. */
    committedMessage?: ActivityRemoteAlertCommittedMessageV2;
    /** Required for committed terminal turn events. */
    committedTurnId?: string;
    /**
     * The Agent-allocated request id of a committed permission/user-action
     * request. It carries the cross-leg identity a recipient device uses to show
     * exactly one alert for one request, whichever leg observed it first.
     */
    committedRequestId?: string;
    /** One-shot targets established by the committed semantic mutation owner. */
    targetAccountIds?: readonly string[];
    /** True only when this committed assignment inserted the recipient's automatic Follow. */
    assignmentAutoFollowed?: boolean;
    /** Authenticated human source of a committed post; never alert that Account about its own post. */
    sourceAccountId?: string;
    /** Accounts receiving a more specific alert for this same committed fact. */
    excludeAccountIds?: readonly string[];
    runtimeComposition?: Readonly<{
        /** Authenticated publisher authority captured by the socket owner for the committed event. */
        publisherAuthority: CurrentSessionPublisherAuthority;
        /** Actual sender composition established by the runtime host before commit. */
        ownerActivityDelivery: "rich_sender" | "home_required";
    }>;
    now?: Date;
}>;

/**
 * The Home leg of the approved closed-app collaborator alert (Lane 09C §10.4 C5b).
 *
 * It composes the existing owners only: Lane 09B decides recipient eligibility,
 * the recipient's own published remote-alert projection plus its device
 * registration decide whether an OS-visible alert is permitted, and the existing
 * Account push transport submits it. Mute and quiet hours are applied **before**
 * submission; no OS fallback is ever the enforcement point.
 *
 * The installed native consumer may enrich the permitted generic fallback
 * after an exact-Home access/key recheck. Missing, locked, timed-out or
 * unsupported enrichment always retains this already-policy-approved copy.
 */
export async function submitSessionActivityRemoteAlerts(
    params: SubmitSessionActivityRemoteAlertsParams,
): Promise<readonly string[]> {
    if (!await isServerFeatureEnabledForHome("sessions.following")) return [];
    const disposition = resolveSessionActivityRemoteAlertDisposition(
        params.event,
        params.committedMessage,
        params.committedTurnId,
        params.committedRequestId,
    );
    if (disposition.kind !== "alert") return [];
    const alertEvent = disposition.event;

    const session = await db.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true } });
    if (!session) return [];

    const recipients = await listSessionPersonalEventRecipients({
        sessionId: params.sessionId,
        event: params.event,
        ...(params.targetAccountIds ? { targetAccountIds: params.targetAccountIds } : {}),
    });
    const richOwnerSenderOwnsDelivery = await resolveRichOwnerSenderResponsibility({
        sessionId: params.sessionId,
        sessionOwnerAccountId: session.accountId,
        alertEventType: alertEvent.type,
        runtimeComposition: params.runtimeComposition,
    });
    const excluded = new Set(params.excludeAccountIds ?? []);
    const candidates = recipients
        .map((recipient) => recipient.accountId)
        .filter((accountId) => accountId !== params.sourceAccountId)
        .filter((accountId) => !excluded.has(accountId))
        .filter((accountId) => !(richOwnerSenderOwnsDelivery && accountId === session.accountId));
    if (candidates.length === 0) return [];

    const policyEvent = ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1[alertEvent.type];
    const now = params.now ?? new Date();
    const serverId = await getOrCreateServerIdentityId(process.env);
    const accounts = await db.account.findMany({
        where: { id: { in: candidates } },
        select: { id: true, settingsVersion: true, remoteAlertPolicy: true },
    });
    const tokens = await db.accountPushToken.findMany({
        where: { accountId: { in: candidates } },
        select: { accountId: true, token: true, remoteAlerts: true },
    });

    const deliveries: AccountPushDelivery[] = [];
    const alerted = new Set<string>();
    const alertedTokens = new Set<string>();
    const mutedTokens = new Set<string>();
    for (const account of accounts) {
        // An absent or stale projection means the recipient's current policy is
        // unknown here, so this leg stays unavailable rather than guessing.
        const currentness = resolveAccountRemoteAlertPolicyCurrentness(account.remoteAlertPolicy, account.settingsVersion);
        if (currentness.status !== "current") continue;
        const muteMobileAlerts = currentness.policy.mutePhoneWhenComputerFocused === true
            && shouldMuteMobileAlertsForComputerFocus({
                mutePhoneWhenComputerFocused: currentness.policy.mutePhoneWhenComputerFocused,
                computerFocused: await eventRouter.hasFocusedComputerUi(account.id),
            });
        for (const token of tokens.filter((row) => row.accountId === account.id)) {
            if (muteMobileAlerts) {
                mutedTokens.add(token.token);
                continue;
            }
            const decision = resolveRemoteAlertPolicyDecision({
                accountPolicy: currentness.policy,
                devicePolicy: token.remoteAlerts,
                event: policyEvent,
                now,
            });
            if (!decision || decision.delivery === "suppress") continue;
            const soundId = decision.delivery === "silent" || decision.sound.kind === "none" || decision.sound.kind === "custom"
                ? "none"
                : decision.sound.id;
            const sound = resolveExpoNotificationSoundName(soundId);
            const data = ActivityRemoteAlertV2Schema.parse({
                type: "activity_alert", v: 2,
                serverId, sessionId: params.sessionId, accountId: account.id,
                event: alertEvent,
                previewBehavior: decision.previewBehavior,
            });
            deliveries.push({
                accountId: account.id,
                token: token.token,
                message: {
                    to: token.token,
                    title: "Happier",
                    body: resolveRemoteAlertFallbackBody(alertEvent, params.assignmentAutoFollowed),
                    ...(sound === null ? {} : { sound }),
                    channelId: resolvePushNotificationAndroidChannelId({
                        kind: alertEvent.type === "permission_request"
                            ? "permission"
                            : alertEvent.type === "user_action_request" ? "user_action" : "ready",
                        soundId,
                    }),
                    priority: decision.delivery === "silent" ? "normal" : "high",
                    mutableContent: true,
                    data,
                },
            });
            alerted.add(account.id);
            alertedTokens.add(token.token);
        }
    }

    // Every eligible recipient device this leg did not alert gets the
    // content-free wake instead, so exactly one leg is responsible for each
    // device and this event. A device the Home could not decide for — no
    // published projection, a stale one, or a policy that declined an OS-visible
    // alert — still reaches its own Activity policy and content builder locally
    // after synchronizing this exact Home.
    const wakeData = SessionChangedWakeV1Schema.parse({
        type: SESSION_CHANGED_WAKE_TYPE,
        serverId,
        sessionId: params.sessionId,
    });
    for (const token of tokens) {
        if (alertedTokens.has(token.token)) continue;
        deliveries.push({
            accountId: token.accountId,
            token: token.token,
            message: {
                to: token.token,
                priority: "normal",
                // A background notification with no alert content: iOS treats it as
                // `content-available`, which the OS may throttle, delay or discard
                // and never delivers to a user-terminated app, and Android receives
                // it as a plain data message. It is best effort by platform
                // contract and never renders anything by itself.
                _contentAvailable: true,
                data: mutedTokens.has(token.token) ? { ...wakeData, alert: 'muted' } : wakeData,
            },
        });
    }

    if (deliveries.length === 0) return [];
    await sendAccountExpoPushMessages(deliveries, "activity-remote-alerts");
    return [...alerted];
}

/**
 * The alert categories the rich owner sender can actually deliver.
 *
 * `ownerActivityDelivery: "rich_sender"` says the runtime host has a push
 * sender, not that its notification vocabulary covers this event. The rich
 * union publishes `ready`, permission and user-action topics (plus its
 * connected-service and workflow topics); it carries no terminal-turn topic, so
 * delegating a `failed`/`cancelled` alert to it drops the owner's alert
 * entirely. Any category outside this set stays the Home's to deliver.
 */
const RICH_OWNER_SENDER_ALERT_EVENTS: ReadonlySet<ActivityRemoteAlertEventV2["type"]> = new Set([
    "ready",
    "permission_request",
    "user_action_request",
]);

async function resolveRichOwnerSenderResponsibility(params: Readonly<{
    sessionId: string;
    sessionOwnerAccountId: string;
    alertEventType: ActivityRemoteAlertEventV2["type"];
    runtimeComposition?: SubmitSessionActivityRemoteAlertsParams["runtimeComposition"];
}>): Promise<boolean> {
    if (!RICH_OWNER_SENDER_ALERT_EVENTS.has(params.alertEventType)) return false;
    const composition = params.runtimeComposition;
    if (!composition || composition.ownerActivityDelivery !== "rich_sender") return false;
    const authority = composition.publisherAuthority;
    if (authority.sessionId !== params.sessionId || authority.accountId !== params.sessionOwnerAccountId) return false;
    return await inTx(async (tx) => {
        if (!await hasExactCurrentPublisherAuthorityInTx(
            tx,
            authority,
            params.sessionOwnerAccountId,
            params.sessionId,
        )) return false;
        const machine = await tx.machine.findUnique({
            where: { id: authority.machineId },
            select: { kind: true },
        });
        return machine?.kind === "persistent";
    });
}

/** Fire-and-forget wrapper for committed mutation owners that must not await transport. */
export function scheduleSessionActivityRemoteAlerts(params: SubmitSessionActivityRemoteAlertsParams): void {
    void submitSessionActivityRemoteAlerts(params).catch((error) => {
        log({ module: "activity-remote-alerts", level: "warn" }, "failed to submit session remote alerts", error);
    });
}
