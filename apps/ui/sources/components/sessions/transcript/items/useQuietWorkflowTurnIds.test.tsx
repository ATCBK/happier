import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { createTestSessionTranscriptSource, renderScreen, standardCleanup, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { createWorkflowInvocationIndexFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storage';
import { useQuietWorkflowTurnIds } from './useQuietWorkflowTurnIds';

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); });
const message: Message = { kind: 'user-text', id: 'habit', localId: null, createdAt: 1, text: 'Summarize the release',
    meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: 'daily', invocationRecordId: 'step' } } };
const items = [{ kind: 'turn' as const, id: 'turn:habit', turn: { id: 'turn:habit', userMessageId: 'habit', content: [] } }];
const getMessage = (id: string) => id === message.id ? message : null;

function publish(condition: 'matched' | 'suppressed', runId = 'daily', id = 'step') {
    storage.getState().upsertWorkflowRunInvocation({ runId, parentRevision: 1,
        invocation: { ...createWorkflowInvocationIndexFixture({ runId, id }), notificationCondition: condition } });
}

describe('quiet workflow turn projection', () => {
    it('folds only a suppressed exact invocation and restores normal rows on matched evidence', async () => {
        storage.setState({ profileScope: { serverId: 'home', accountId: 'account' } });
        let result = new Set<string>();
        let renders = 0;
        function Probe() { result = useQuietWorkflowTurnIds(items, getMessage); renders += 1; return null; }
        const source = { ...createTestSessionTranscriptSource({ serverId: 'home', messages: [message] }), kind: 'app' as const };
        await renderScreen(wrapWithSessionTranscriptSource(<Probe />, source));
        expect([...result]).toEqual([]);
        await act(async () => publish('suppressed', 'unrelated'));
        await act(async () => publish('suppressed', 'daily', 'other-step'));
        expect(renders).toBe(1);
        await act(async () => publish('suppressed'));
        expect([...result]).toEqual(['turn:habit']);
        await act(async () => publish('matched'));
        expect([...result]).toEqual([]);
        await act(async () => publish('suppressed'));
        expect([...result]).toEqual([]); // producer/store's matched-dominates merge remains authoritative
    });

    it('keeps find and exact deep-link targets visible without changing the notification fact', async () => {
        storage.setState({ profileScope: { serverId: 'home', accountId: 'account' } });
        publish('suppressed');
        const source = { ...createTestSessionTranscriptSource({ serverId: 'home' }), kind: 'app' as const };
        let result = new Set<string>();
        function Probe(props: { findActive: boolean; jumpToSeq: number | null }) {
            result = useQuietWorkflowTurnIds(items, (id) => id === message.id ? { ...message, seq: 7 } : null, props);
            return null;
        }
        const screen = await renderScreen(wrapWithSessionTranscriptSource(<Probe findActive={false} jumpToSeq={null} />, source));
        expect([...result]).toEqual(['turn:habit']);
        await screen.update(wrapWithSessionTranscriptSource(<Probe findActive jumpToSeq={null} />, source));
        expect([...result]).toEqual([]);
        await screen.update(wrapWithSessionTranscriptSource(<Probe findActive={false} jumpToSeq={7} />, source));
        expect([...result]).toEqual([]);
        expect(storage.getState().workflowRunInvocationsByRunId.daily?.factsById.step?.notificationCondition).toBe('suppressed');
    });

    it('does not fold static/public or another Home transcripts using private Account facts', async () => {
        storage.setState({ profileScope: { serverId: 'home', accountId: 'account' } });
        publish('suppressed');
        const results: string[][] = [];
        function Probe() { results.push([...useQuietWorkflowTurnIds(items, getMessage)]); return null; }
        await renderScreen(wrapWithSessionTranscriptSource(<Probe />, createTestSessionTranscriptSource({ serverId: 'home' })));
        await renderScreen(wrapWithSessionTranscriptSource(<Probe />, {
            ...createTestSessionTranscriptSource({ serverId: 'other-home' }), kind: 'app',
        }));
        expect(results).toEqual([[], []]);
    });
});
