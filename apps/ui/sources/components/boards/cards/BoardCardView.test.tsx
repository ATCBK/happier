import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { isSessionListRowVisible } from '@/sync/domains/session/sessionSurfaceVisibility';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { buildBoardCards, type BoardCard } from '../model/boardCards';
import { BoardCardView } from './BoardCardView';

const hydrateSessionListRows = vi.hoisted(() => vi.fn(async (_addresses: readonly { serverId: string; sessionId: string }[]) => undefined));
vi.mock('@/sync/sync', () => ({ sync: { hydrateSessionListRows } }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(async () => { await standardCleanup(); vi.useRealTimers(); });

function runCard(state: 'cancelled' | 'outcome_uncertain' | 'waiting_for_review'): BoardCard {
    const ref = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'run-1' } } as const;
    return buildBoardCards([{ key: 'run', ref, picked: true, sourced: false, available: true }], {
        nowMs: Date.now(), session: () => null, machine: () => null, workflow: () => null,
        machineSessionCounts: new Map(), accountScopedHome: () => true,
        workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ state,
            workflowCustodyState: state === 'cancelled' ? 'settled' : 'pending',
            attentionRequired: true, createdAt: new Date(Date.now() - 120_000).toISOString() }), null),
    })[0]!;
}

describe('Board body facts', () => {
    it('offers native Review for a held Run and Run now for a readable workflow without answering inline', async () => {
        const onAction = vi.fn();
        const held = runCard('waiting_for_review');
        const screen = await renderScreen(<BoardCardView card={held} onAction={onAction} />);
        const review = screen.findHostByTestId('board-card:run:review');
        expect(review).not.toBeNull();
        // The action is a sibling of the card's open target, so its press needs no propagation guard.
        await act(async () => { review!.props.onPress(); });
        expect(onAction).toHaveBeenLastCalledWith(held, 'review');
        for (const state of ['cancelled', 'outcome_uncertain'] as const) {
            await screen.update(<BoardCardView card={runCard(state)} onAction={onAction} />);
            expect(screen.findHostByTestId('board-card:run:review')).toBeNull();
        }
        const workflow = buildBoardCards([{ key: 'definition', ref: { kind: 'workflow',
            qualifiedId: { serverId: 'home-a', id: 'definition-1' } }, picked: true, sourced: false, available: true }], {
            nowMs: Date.now(), session: () => null, machine: () => null, workflowRun: () => null,
            machineSessionCounts: new Map(), accountScopedHome: () => true,
            workflow: () => ({ title: 'Workflow', summary: null }),
        })[0]!;
        await screen.update(<BoardCardView card={workflow} onAction={onAction} />);
        const runNow = screen.findHostByTestId('board-card:definition:run');
        expect(runNow).not.toBeNull();
        await act(async () => { runNow!.props.onPress(); });
        expect(onAction).toHaveBeenLastCalledWith(workflow, 'run');
        await screen.update(<BoardCardView card={{ ...workflow, availability: 'content_unavailable' }} onAction={onAction} />);
        expect(screen.findHostByTestId('board-card:definition:run')).toBeNull();
    });

    it('keeps a stopped Run neutral with its outcome and age, and names genuine attention without inventing review eligibility', async () => {
        const stopped = runCard('cancelled');
        expect(stopped.status).toMatchObject({ bucket: 'finished', tone: 'neutral' });
        const screen = await renderScreen(<BoardCardView card={stopped} />);
        expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
        expect(screen.getTextContent()).toContain('boards.card.run.started(age=time.minutesAgoShort(count=2))');
        expect(screen.getTextContent()).not.toContain('workStatus.buckets.needs_you');
        expect(screen.getTextContent()).not.toContain('boards.card.run.waitingForYou');
        await screen.update(<BoardCardView card={runCard('outcome_uncertain')} />);
        expect(screen.getTextContent()).toContain('workflows.runState.outcome_uncertain');
        expect(screen.getTextContent()).toContain('workStatus.buckets.needs_you');
        expect(screen.getTextContent()).not.toContain('boards.card.run.waitingForYou');
        await screen.update(<BoardCardView card={runCard('waiting_for_review')} />);
        // The hold is named once, by the card's state word; the body does not restate it in other words.
        expect(screen.getTextContent().split('workStatus.buckets.needs_you')).toHaveLength(2);
        expect(screen.getTextContent()).not.toContain('workflows.review.waitTitle');
        expect(screen.getTextContent()).not.toContain('boards.card.run.waitingForYou');
        // In a status group the title row drops the word, so the hold moves to its own line.
        await screen.update(<BoardCardView card={runCard('waiting_for_review')} showStatusWord={false} />);
        expect(screen.getTextContent().split('workStatus.buckets.needs_you')).toHaveLength(2);
    });

    it('refreshes workflow countdown and Run age with unchanged cards while unrelated cards stay stable', async () => {
        vi.useFakeTimers();
        const now = new Date(2026, 9, 10, 10).getTime();
        vi.setSystemTime(now);
        const base = runCard('cancelled');
        const workflow: BoardCard = { ...base, key: 'workflow', ref: { kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf' } },
            body: { kind: 'workflow', needsYouCount: 0, lastRunWord: 'Succeeded', lastRunAt: new Date(now - 90_000).toISOString(),
                runSummaryAvailable: true, triggerSummary: null, nextRun: { kind: 'scheduled', at: now + 120_000 } } };
        const run: BoardCard = { ...base, key: 'age', body: { kind: 'workflow_run', runId: 'run-1', state: 'cancelled', attentionLabel: null,
            startedAt: new Date(now - 90_000).toISOString(), progress: null } };
        let idleReads = 0;
        const idle: BoardCard = { ...base, key: 'idle', body: { get kind() { idleReads += 1; return 'none' as const; } } };
        const screen = await renderScreen(<><BoardCardView card={workflow} /><BoardCardView card={run} /><BoardCardView card={idle} /></>);
        const before = idleReads;
        expect(screen.getTextContent()).toContain('nextMinutes(count=2)');
        // The age wakes at the half-minute; flush React's next deadline registration before
        // the countdown's rounded label changes one millisecond later, as the live loop does.
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(screen.getTextContent()).toContain('nextMinutes(count=2)');
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(screen.getTextContent()).toContain('nextMinutes(count=1)');
        expect(screen.getTextContent()).toContain('time.minutesAgoShort(count=2)');
        expect(idleReads).toBe(before);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('names a workflow\'s last-run outcome once: in the state word when shown, in the body when the group hides it', async () => {
        const base = runCard('cancelled');
        const workflow = (word: string, tone: 'attention' | 'neutral'): BoardCard => ({ ...base, key: 'workflow',
            ref: { kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf' } },
            status: { state: 'interrupted', attentionType: tone === 'attention' ? 'decision' : null,
                bucket: tone === 'attention' ? 'needs_you' : 'idle', tone, word },
            body: { kind: 'workflow', needsYouCount: 0, lastRunWord: word, lastRunAt: new Date(Date.now() - 90_000).toISOString(),
                runSummaryAvailable: true, triggerSummary: null, nextRun: { kind: 'unscheduled' } } });
        const count = (text: string, word: string) => text.split(word).length - 1;
        const shown = await renderScreen(<BoardCardView card={workflow('Interrupted', 'attention')} />);
        expect(count(shown.getTextContent(), 'Interrupted')).toBe(1);
        expect(shown.getTextContent()).toContain('boards.card.workflow.lastRunAt');
        const grouped = await renderScreen(<BoardCardView card={workflow('Succeeded', 'neutral')} showStatusWord={false} />);
        expect(count(grouped.getTextContent(), 'Succeeded')).toBe(1);
        const groupedNeedsYou = await renderScreen(<BoardCardView card={workflow('Interrupted', 'attention')} showStatusWord={false} />);
        expect(count(groupedNeedsYou.getTextContent(), 'Interrupted')).toBe(1);
    });

    it('drops the kind line when the title already reads as the kind (an untitled Run)', async () => {
        const named = { ...runCard('cancelled'), title: 'Prepare the 0.3 release' };
        const untitled = { ...runCard('cancelled'), title: 'boards.kinds.workflow_run' };
        expect((await renderScreen(<BoardCardView card={named} />)).getTextContent()).toContain('boards.kinds.workflow_run');
        await standardCleanup();
        expect((await renderScreen(<BoardCardView card={untitled} />)).getTextContent().split('boards.kinds.workflow_run')).toHaveLength(2);
    });
    it('says a settled unavailable item once: the kind as its title, one status word and one reason, with no placeholder or repeated kind', async () => {
        const card = buildBoardCards([{ key: 'gone', ref: { kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-gone' } },
            picked: true, sourced: false, available: true }], {
            nowMs: Date.now(), session: () => null, machine: () => null, workflowRun: () => null, workflow: () => null,
            machineSessionCounts: new Map(), accountScopedHome: () => true,
            missingEntityReason: () => 'boards.card.missing',
        })[0]!;
        const text = (await renderScreen(<BoardCardView card={card} />)).getTextContent();
        expect(text).toContain('boards.kinds.session');
        expect(text.split('boards.kinds.session')).toHaveLength(2);
        expect(text.split('boards.card.unavailable')).toHaveLength(2);
        expect(text.split('boards.card.missing')).toHaveLength(2);
        expect(text).not.toContain('boards.card.untitled');
        expect(text).not.toContain('boards.card.notLoaded');
    });
    it('says an unreadable Session once too: titled by its kind, one status word and one reason, no second kind line', async () => {
        const card: BoardCard = { key: 'locked', ref: { kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-locked' } }, picked: true,
            availability: 'ready', title: 'boards.kinds.session', status: { state: 'unavailable', attentionType: null, bucket: 'idle', tone: 'neutral', word: 'boards.card.unavailable' },
            body: { kind: 'session', serverId: 'home-a', sessionId: 's-locked', statusDetail: 'boards.card.readFailed' } };
        const text = (await renderScreen(<BoardCardView card={card} />)).getTextContent();
        expect(text.split('boards.kinds.session')).toHaveLength(2);
        expect(text.split('boards.card.unavailable')).toHaveLength(2);
        expect(text.split('boards.card.readFailed')).toHaveLength(2);
    });
    it('demands the content of a Session card nobody has decided yet for as long as the card is shown, so it is not left "Encrypted"', async () => {
        storage.setState({ sessionListRowsByServerId: { 'home-a': { 's-undecided': createSessionListRenderableSessionFixture({
            id: 's-undecided', encryptionMode: 'e2ee', encryptedContentAvailability: undefined }) } } });
        const card: BoardCard = { key: 'undecided', ref: { kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-undecided' } }, picked: true,
            availability: 'ready', title: 'boards.kinds.session', status: { state: 'unknown', attentionType: null, bucket: 'idle', tone: 'neutral', word: 'Idle' },
            body: { kind: 'session', serverId: 'home-a', sessionId: 's-undecided' } };
        hydrateSessionListRows.mockClear();
        const screen = await renderScreen(<BoardCardView card={card} />);
        expect(hydrateSessionListRows).toHaveBeenCalledWith([{ serverId: 'home-a', sessionId: 's-undecided' }]);
        expect(isSessionListRowVisible('s-undecided', 'home-a')).toBe(true);
        await screen.unmount();
        expect(isSessionListRowVisible('s-undecided', 'home-a')).toBe(false);
        storage.setState({ sessionListRowsByServerId: {} });
    });
    it('in a status group, keeps what a needs-you card waits for and drops a healthy word the group already says', async () => {
        const session = (word: string, tone: 'attention' | 'neutral', bucket: 'needs_you' | 'idle'): BoardCard => ({
            key: `session:${word}`, ref: { kind: 'session', qualifiedId: { serverId: 'home-a', id: word } }, picked: true,
            availability: 'ready', title: 'Checkout UI retry states', status: { state: bucket,
                attentionType: bucket === 'needs_you' ? 'approval' : null, bucket, tone, word },
            body: { kind: 'session', serverId: 'home-a', sessionId: word } });
        const screen = await renderScreen(<>
            <BoardCardView card={session('Permission required', 'attention', 'needs_you')} showStatusWord={false} />
            <BoardCardView card={session('Idle', 'neutral', 'idle')} showStatusWord={false} />
        </>);
        expect(screen.getTextContent()).toContain('Permission required');
        expect(screen.getTextContent()).not.toContain('Idle');
    });
});
