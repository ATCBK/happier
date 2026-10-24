import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import * as React from 'react';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { projectSessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import { SessionMessageReplyReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { SessionAskRecord } = await import('./SessionAskRecord');
const { AppSessionTranscriptSourceProvider } = await import('../source/appSessionTranscriptSource');
beforeEach(async () => { await homes.reset(); });
afterEach(standardCleanup);

/** The composer's one non-executing entry, round-tripped through the real transcript reducer. */
function composerEntry(serverId: string, target: SessionTargetV1, results: ReadonlyArray<readonly [string, ActionExecuteResult]>, reply: 'none' | 'return' = 'return') {
    const invocation = projectSessionMessageInvocationV1({ serverId, localId: 'attempt', requestLocalId: 'attempt', target, reply,
        result: typeof target === 'string' ? results[0]![1] : { ok: true, result: { kind: 'fanout',
            results: results.map(([sessionId, result]) => ({ target: { serverId, sessionId }, result })) } } });
    const raw = normalizeRawMessage('source-entry', 'attempt', 10, { role: 'agent', content: { type: 'event', id: 'attempt', data: {
        type: 'message', message: 'Does a replayed charge need a different banner?', sessionMessageInvocationV1: invocation,
    } } }, { messageRole: 'event', seq: 1 });
    if (!raw) throw new Error('Source entry must normalize');
    return reducer(createReducer(), [raw]).messages[0]!;
}
const accepted = { ok: true, result: { status: 'accepted', localId: 'attempt' } } as const satisfies ActionExecuteResult;
const refused = { ok: false, errorCode: 'permission_denied', error: 'Unavailable' } as const satisfies ActionExecuteResult;

async function activateHome(serverId: string) {
    const { storage } = await import('@/sync/domains/state/storage');
    const { publishAppliedActiveServerSnapshot, getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const previousRuntime = getAppliedActiveServerSnapshot();
    const previousAvailable = isAppliedActiveServerRuntimeAvailable();
    const previousState = storage.getState();
    onTestFinished(() => { publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable); storage.setState(previousState, true); });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://ask-record.test', generation: previousRuntime.generation + 1 });
}

function answerReplies(serverId: string, outcomes: Readonly<Record<string, 'answer' | 'pass'>>) {
    homes.answer(serverId, 'POST /v2/sessions/messages/replies/read-batch', { select: input => ({ body: {
        results: SessionMessageReplyReadBatchRequestV1Schema.parse(input).requests.map(key => ({ ...key, reply: {
            v: 1, status: 'available', progress: { v: 1, mode: 'return', humanOrigin: { sessionId: 'source' },
                disposition: outcomes[key.sessionId] ? 'returned' : 'observing',
                ...(outcomes[key.sessionId] ? { outcome: outcomes[key.sessionId] === 'pass' ? { kind: 'pass' }
                    : { kind: 'answer', result: { sessionId: key.sessionId, messageId: `answer-${key.sessionId}` } } } : {}) },
        } })),
    } }) });
}

const label = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) => screen.findHostByTestId(`${id}:label`)?.children.join('') ?? null;

describe('Ask record row', () => {
    it('shows the person’s text once, one result line per frozen target and the live answer, pass and refusal', async () => {
        const serverId = await homes.addHome({ name: 'Ask record', serverUrl: 'https://ask-record.test', accountId: 'alice', currentAccount: true });
        await activateHome(serverId);
        answerReplies(serverId, { a: 'answer', c: 'pass' });
        const message = composerEntry(serverId, { selector: 'siblings' }, [['a', accepted], ['b', refused], ['c', accepted]]);
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="source" serverId={serverId}>
            <SessionAskRecord message={message} sessionId="source" serverId={serverId} />
        </AppSessionTranscriptSourceProvider>);
        await flushHookEffects({ cycles: 20 });
        expect(screen.getTextContent().split('Does a replayed charge need a different banner?').length - 1).toBe(1);
        expect(screen.getTextContent()).toContain('Siblings');
        expect(label(screen, 'session-ask-record-target-state:a')).toBe('Answered');
        expect(label(screen, 'session-ask-record-target-state:c')).toBe('Passed');
        expect(label(screen, 'session-ask-record-target-state:b')).toBe('Not sent');
        expect(screen.getTextContent()).toContain('1 answered · 1 passed · 1 not delivered');
        await screen.unmount();
    });
});
