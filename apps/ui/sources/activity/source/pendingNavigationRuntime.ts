import * as React from 'react';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionPendingNextOutput } from '@happier-dev/protocol/actions/actionSpecs';

export type PendingNavigationResult = SessionPendingNextOutput;
export type PendingNavigationUnavailableReason = NonNullable<Extract<PendingNavigationResult, { status: 'unavailable' }>['reason']>;
export type PendingNavigationInvocation = Readonly<{
    excluding?: SessionAddress | null;
    expectedServerId?: string | null;
    signal?: AbortSignal;
}>;
export type PendingNavigationLanding = Readonly<{
    address: SessionAddress;
    requestId: string;
    requestSource?: string;
    state: 'pending' | 'settled';
    focusTarget: 'transcript' | 'prompt';
    token: number;
}>;

let handler: ((options: PendingNavigationInvocation) => Promise<PendingNavigationResult>) | null = null;
let landing: PendingNavigationLanding | null = null;
let answered: Readonly<{ address: SessionAddress; requestId: string; token: number }> | null = null;
let nextToken = 1;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
const emit = () => { for (const listener of listeners) listener(); };

/** One mounted app-shell navigation owner, shared by Actions, keys and pills. */
export function registerPendingNavigationRuntime(next: NonNullable<typeof handler>): () => void {
    handler = next;
    return () => {
        if (handler !== next) return;
        handler = null;
        clearPendingNavigationState();
    };
}

export async function invokeNextPendingRequest(options: PendingNavigationInvocation = {}): Promise<PendingNavigationResult> {
    if (options.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (!handler) return { status: 'unavailable', reason: 'no_navigation_host' };
    return handler(options);
}

/** Ephemeral landing intent; never a pending-request authority or a saved cursor. */
export function setPendingNavigationLanding(address: SessionAddress, requestId: string, state: 'pending' | 'settled' = 'pending', focusTarget: 'transcript' | 'prompt' = 'prompt', requestSource?: string): void {
    landing = { address, requestId, state, focusTarget, ...(requestSource ? { requestSource } : {}), token: nextToken++ };
    emit();
}

export function markPendingNavigationSettled(address: SessionAddress, requestId: string): void {
    if (!landing || landing.state === 'settled' || landing.requestId !== requestId || !areSessionAddressesEqual(address, landing.address)) return;
    landing = { ...landing, state: 'settled' };
    emit();
}

/** An async reveal cannot resurrect an answered or superseded landing. */
export function markPendingNavigationTranscriptReady(expected: PendingNavigationLanding): void {
    if (!landing || landing.token !== expected.token || landing.state !== 'pending'
        || landing.focusTarget === 'transcript') return;
    landing = { ...landing, focusTarget: 'transcript' };
    emit();
}

export function markSessionPendingAnswer(address: SessionAddress, requestId: string): void {
    if (landing !== null && landing.requestId === requestId && areSessionAddressesEqual(address, landing.address)) {
        landing = null;
    }
    answered = { address, requestId, token: nextToken++ };
    emit();
}

export function clearPendingNavigationState(serverId?: string): void {
    const clearLanding = landing !== null && (serverId === undefined
        || areServerProfileIdentifiersEquivalent(landing.address.serverId, serverId));
    const clearAnswered = answered !== null && (serverId === undefined
        || areServerProfileIdentifiersEquivalent(answered.address.serverId, serverId));
    if (!clearLanding && !clearAnswered) return;
    if (clearLanding) landing = null;
    if (clearAnswered) answered = null;
    emit();
}

export function usePendingNavigationLanding(address: SessionAddress | null, requestId?: string): PendingNavigationLanding | null {
    const serverId = address?.serverId;
    const sessionId = address?.sessionId;
    const read = React.useCallback(() => (
        landing !== null && landing.address.serverId === serverId && landing.address.sessionId === sessionId
            && (requestId === undefined || landing.requestId === requestId) ? landing : null
    ), [serverId, sessionId, requestId]);
    return React.useSyncExternalStore(subscribe, read, read);
}

export function useSessionPendingAnswerToken(address: SessionAddress | null, requestId?: string): number | null {
    const serverId = address?.serverId;
    const sessionId = address?.sessionId;
    const read = React.useCallback(() => (
        answered !== null && answered.address.serverId === serverId && answered.address.sessionId === sessionId
            && (requestId === undefined || answered.requestId === requestId) ? answered.token : null
    ), [serverId, sessionId, requestId]);
    return React.useSyncExternalStore(subscribe, read, read);
}
