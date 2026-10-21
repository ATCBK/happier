import * as React from 'react';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import { useShallow } from 'zustand/react/shallow';

import { storage } from '@/sync/domains/state/storage';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import { useActivityAttentionSource } from '@/activity/source/useActivityAttentionSource';
import { derivePendingRequestFlagsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { Message } from "@happier-dev/session-core/messages";
import { deriveSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { Session } from '@/sync/domains/state/storageTypes';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { SessionPending } from '@/sync/store/domains/pending';

import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';
import type {
    PetCompanionActivityModel,
    PetCompanionSessionSignals,
} from './petCompanionActivityTypes';

function selectCompanionSessionAddress(candidates: readonly SessionActivityAttention[]): SessionAddress | null {
    return candidates.find((candidate) => candidate.session.active)?.address
        ?? candidates[0]?.address
        ?? null;
}

function normalizeMessageSubtitleText(value: string | null | undefined): string | null {
    const text = readableMessageText(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 0 ? text : null;
}

function resolveMessageSubtitle(message: Message): string | null {
    switch (message.kind) {
        case 'agent-text':
            return normalizeMessageSubtitleText(message.text);
        case 'user-text':
            return normalizeMessageSubtitleText(message.displayText ?? message.text);
        case 'tool-call':
            return (
                normalizeMessageSubtitleText(message.tool.description)
                ?? normalizeMessageSubtitleText(message.tool.name)
            );
        case 'agent-event':
            return null;
    }
}

function resolveLatestCommittedMessageSubtitle(transcript: SessionMessages | undefined): string | null {
    const messageIdsOldestFirst = transcript?.messageIdsOldestFirst ?? [];
    for (let index = messageIdsOldestFirst.length - 1; index >= 0; index -= 1) {
        const messageId = messageIdsOldestFirst[index];
        if (!messageId) continue;
        const message = transcript?.messagesById?.[messageId] ?? transcript?.messagesMap?.[messageId];
        if (!message) continue;
        const subtitle = resolveMessageSubtitle(message);
        if (subtitle) return subtitle;
    }
    return null;
}

type PetCompanionSignalState = Readonly<{
    sessionMessages: Readonly<Record<string, SessionMessages | undefined>>;
    sessionPending: Readonly<Record<string, SessionPending | undefined>>;
}>;

function usePetCompanionSignalState(sessionIds: readonly string[]): PetCompanionSignalState {
    const transcripts = storage(
        useShallow((state) => sessionIds.map((sessionId) => state.sessionMessages?.[sessionId])),
    );
    const pendingRows = storage(
        useShallow((state) => sessionIds.map((sessionId) => state.sessionPending?.[sessionId])),
    );

    return React.useMemo(() => {
        const sessionMessages: Record<string, SessionMessages | undefined> = {};
        const sessionPending: Record<string, SessionPending | undefined> = {};

        for (let index = 0; index < sessionIds.length; index += 1) {
            const sessionId = sessionIds[index];
            if (!sessionId) continue;
            sessionMessages[sessionId] = transcripts[index];
            sessionPending[sessionId] = pendingRows[index];
        }

        return { sessionMessages, sessionPending };
    }, [pendingRows, sessionIds, transcripts]);
}

function buildSessionSignalsByAddressKey(
    state: PetCompanionSignalState,
    candidates: readonly SessionActivityAttention[],
    activeServerId: string | null,
): Record<string, PetCompanionSessionSignals> {
    const signalsByAddressKey: Record<string, PetCompanionSessionSignals> = {};
    const sessionMessages = state.sessionMessages ?? {};
    const sessionPending = state.sessionPending ?? {};

    for (const candidate of candidates) {
        if (!candidate.address) continue;
        const session = candidate.session;
        const mayUseActiveHomeState = candidate.address.serverId === activeServerId;
        const transcript = mayUseActiveHomeState ? sessionMessages[session.id] : undefined;
        const pending = mayUseActiveHomeState ? sessionPending[session.id] : undefined;
        const messages = Object.values(transcript?.messagesById ?? {});
        const latestCommittedMessageId =
            transcript?.messageIdsOldestFirst?.length
                ? transcript.messageIdsOldestFirst[transcript.messageIdsOldestFirst.length - 1] ?? null
                : null;
        const latestCommittedMessageCreatedAt =
            latestCommittedMessageId != null
                ? transcript?.messagesById?.[latestCommittedMessageId]?.createdAt ?? null
                : null;

        let latestPendingMessageCreatedAt: number | null = null;
        for (const pendingMessage of pending?.messages ?? []) {
            const createdAt = pendingMessage?.createdAt;
            if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) continue;
            latestPendingMessageCreatedAt =
                latestPendingMessageCreatedAt == null ? createdAt : Math.max(latestPendingMessageCreatedAt, createdAt);
        }
        const pendingRequestFlags = derivePendingRequestFlagsFromSession(session, messages);

        signalsByAddressKey[sessionAddressKey(candidate.address)] = {
            hasFailure: candidate.attentionState === 'failed',
            hasPendingPermissionRequests: candidate.reasons.hasPendingPermissionRequests
                || pendingRequestFlags.hasPendingPermissionRequests,
            hasPendingUserActionRequests: candidate.reasons.hasPendingUserActionRequests
                || pendingRequestFlags.hasPendingUserActionRequests,
            hasUnreadMessages: candidate.reasons.hasUnread,
            latestThinkingActivityAtMs: transcript?.latestThinkingMessageActivityAtMs ?? null,
            latestMeaningfulActivityAtMs: deriveSessionListMeaningfulActivityAt({
                sessionMeaningfulActivityAt: session.meaningfulActivityAt,
                sessionCreatedAt: session.createdAt,
                latestCommittedMessageCreatedAt,
                latestPendingMessageCreatedAt,
            }),
            lastMessageSubtitle: resolveLatestCommittedMessageSubtitle(transcript)
                ?? candidate.subtitle
                ?? null,
            pendingMessageCount: pending?.messages?.length ?? 0,
        };
    }

    return signalsByAddressKey;
}

export function usePetCompanionActivityModel(input?: Readonly<{
    dismissedTrayItemKeys?: ReadonlySet<string>;
}>): PetCompanionActivityModel {
    const activitySource = useActivityAttentionSource();
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    const overview = React.useMemo(
        () => buildActivityOverviewFromSource({
            source: activitySource,
            nowMs,
            includeWarmSourceWhenNotReady: true,
        }),
        [activitySource, nowMs],
    );
    const activityCandidates = overview.candidates;
    const activitySessions = React.useMemo(
        () => activityCandidates.flatMap((candidate) => candidate.address
            ? [{ ...candidate.session, serverId: candidate.address.serverId }]
            : []),
        [activityCandidates],
    );
    const signalSessionIds = React.useMemo(
        () => activityCandidates.map((candidate) => candidate.session.id),
        [activityCandidates],
    );
    const selectedAddress = React.useMemo(
        () => selectCompanionSessionAddress(activityCandidates),
        [activityCandidates],
    );
    const dismissedTrayItemKeys = input?.dismissedTrayItemKeys;
    const signalState = usePetCompanionSignalState(signalSessionIds);
    const signalsByAddressKey = React.useMemo(
        () => buildSessionSignalsByAddressKey(
            signalState,
            activityCandidates,
            activitySource.activeServer?.serverId ?? null,
        ),
        [activityCandidates, activitySource.activeServer?.serverId, signalState],
    );
    const contextsByAddressKey = React.useMemo(() => Object.fromEntries(
        activityCandidates.flatMap((candidate) => candidate.address
            ? [[sessionAddressKey(candidate.address), candidate.context ?? null] as const]
            : []),
    ), [activityCandidates]);

    const model = React.useMemo(() => buildPetCompanionActivityModel({
        sessions: activitySessions,
        selectedAddress,
        signalsByAddressKey,
        contextsByAddressKey,
        dismissedTrayItemKeys,
        nowMs,
    }), [activitySessions, contextsByAddressKey, dismissedTrayItemKeys, nowMs, selectedAddress, signalsByAddressKey]);

    React.useEffect(() => {
        let nextExpiryAtMs: number | null = null;
        for (const item of model.trayItems) {
            if (typeof item.expiresAtMs !== 'number' || !Number.isFinite(item.expiresAtMs)) continue;
            if (item.expiresAtMs <= nowMs) continue;
            nextExpiryAtMs = nextExpiryAtMs === null ? item.expiresAtMs : Math.min(nextExpiryAtMs, item.expiresAtMs);
        }
        if (nextExpiryAtMs === null) return undefined;
        const delayMs = Math.max(1, nextExpiryAtMs - nowMs + 1);
        const timeout = setTimeout(() => {
            setNowMs(Date.now());
        }, delayMs);
        return () => clearTimeout(timeout);
    }, [model.trayItems, nowMs]);

    return model;
}
