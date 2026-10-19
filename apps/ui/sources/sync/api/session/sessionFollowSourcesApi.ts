import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { executeSessionFollowAction, type SessionFollowApiResult } from './sessionFollowApi';

export type SessionFollowSourcesResult<T> = SessionFollowApiResult<T>;
export type SessionFollowSourcesFailure = Extract<SessionFollowApiResult<never>, { kind: 'failed' }>;

/** Source-owned reverse read; personal rows are the caller's own, peopleCount is anonymous. */
export function listSessionFollowers(source: SessionAddress, signal?: AbortSignal, expectedAccountId?: string) {
    return executeSessionFollowAction('follow.list', {
        direction: 'followers', source: { kind: 'session', sessionId: source.sessionId },
    }, source.serverId, signal, expectedAccountId);
}

export async function listSessionFollowSources(destination: SessionAddress) {
    const result = await executeSessionFollowAction('follow.list', {
        direction: 'following',
        receiver: { kind: 'session', sessionId: destination.sessionId },
    }, destination.serverId);
    return result.kind === 'ok'
        ? { kind: 'ok' as const, value: { sources: result.value.sources, coverage: result.value.coverage } }
        : result;
}

export function setSessionFollowSource(input: Readonly<{
    serverId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    policy: FollowPolicyV1;
}>) {
    return executeSessionFollowAction('follow.set', {
        receiver: { kind: 'session', sessionId: input.destinationSessionId },
        source: { kind: 'session', sessionId: input.sourceSessionId },
        policy: input.policy,
    }, input.serverId);
}

export function removeSessionFollowSource(input: Readonly<{
    serverId: string;
    destinationSessionId: string;
    sourceSessionId: string;
}>) {
    return executeSessionFollowAction('follow.remove', {
        receiver: { kind: 'session', sessionId: input.destinationSessionId },
        source: { kind: 'session', sessionId: input.sourceSessionId },
    }, input.serverId);
}
