import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

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

/** A Session source by its id, or any other source kind (Discussion, Execution Run, Workflow Run) by its exact ref. */
type SessionFollowSourcePair = Readonly<{
    serverId: string;
    destinationSessionId: string;
}> & (Readonly<{ sourceSessionId: string }> | Readonly<{ source: FollowSourceRefV1 }>);

function readSourceRef(input: SessionFollowSourcePair): FollowSourceRefV1 {
    return 'source' in input ? input.source : { kind: 'session', sessionId: input.sourceSessionId };
}

export function setSessionFollowSource(input: SessionFollowSourcePair & Readonly<{ policy: FollowPolicyV1 }>) {
    return executeSessionFollowAction('follow.set', {
        receiver: { kind: 'session', sessionId: input.destinationSessionId },
        source: readSourceRef(input),
        policy: input.policy,
    }, input.serverId);
}

export function removeSessionFollowSource(input: SessionFollowSourcePair) {
    return executeSessionFollowAction('follow.remove', {
        receiver: { kind: 'session', sessionId: input.destinationSessionId },
        source: readSourceRef(input),
    }, input.serverId);
}
