import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { Message } from '@happier-dev/session-core/messages';

import { createSessionAccessFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const executionRunDetailsSpy = vi.hoisted(() => vi.fn());
const messageDetailsSpy = vi.hoisted(() => vi.fn());
const overviewCardSpy = vi.hoisted(() => vi.fn());
const participantComposerSpy = vi.hoisted(() => vi.fn());

function createPassthroughComponentMock(typeName: string, spy: (props: unknown) => void) {
    return (props: unknown) => {
        spy(props);
        return React.createElement(typeName);
    };
}

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/components/sessions/runs/details/SessionExecutionRunDetailsView', () => ({
    SessionExecutionRunDetailsView: createPassthroughComponentMock('SessionExecutionRunDetailsView', executionRunDetailsSpy),
}));
vi.mock('@/components/sessions/transcript/details/SessionMessageDetailsView', () => ({
    SessionMessageDetailsView: createPassthroughComponentMock('SessionMessageDetailsView', messageDetailsSpy),
}));
vi.mock('@/components/sessions/agents/details/SessionSubagentOverviewCard', () => ({
    SessionSubagentOverviewCard: createPassthroughComponentMock('SessionSubagentOverviewCard', overviewCardSpy),
}));
vi.mock('@/components/sessions/participants/composer/SessionParticipantComposer', () => ({
    SessionParticipantComposer: createPassthroughComponentMock('SessionParticipantComposer', participantComposerSpy),
}));

const browser = await installBrowserRuntimeForTests({ url: 'https://subagent.test/' });
afterAll(() => browser.restore());
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
let listedRuns: ReturnType<typeof ExecutionRunPublicStateSchema.parse>[] = [];
installSessionActionRpcBoundary(request => {
    if (request.method.endsWith(':execution.run.list')) return { runs: listedRuns };
    throw new Error('Unexpected Subagent Details RPC');
});
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { sync } = await import('@/sync/sync');
const { SessionSubagentDetailsView } = await import('./SessionSubagentDetailsView');
const initialStorageState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';
let sourceVersion = 0;

function seedMessages(messages: readonly Message[], isLoaded = true) {
    sourceVersion += 1;
    const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
    getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: messages.map(message => message.id), messagesById,
        isLoaded, messagesVersion: sourceVersion, subagentSourceVersion: sourceVersion,
    }) } });
}

function runTool(runId = 'run_1') {
    return createToolCallMessageFixture({
        id: 'tool-msg-1',
        createdAt: Date.now(),
        tool: { id: 'toolu_1', name: 'SubAgentRun', state: 'running',
            input: { runId, label: 'Code review', backendId: 'codex' }, result: {},
            createdAt: Date.now(), startedAt: Date.now(), completedAt: null, description: null },
    });
}

function teamTool(member: string, messageId: string, toolId: string) {
    return createToolCallMessageFixture({
        id: messageId,
        createdAt: Date.now(),
        tool: { id: toolId, name: 'Task', state: 'completed',
            input: { team_name: 'qa-team', name: member }, result: {},
            createdAt: Date.now(), startedAt: Date.now(), completedAt: Date.now(), description: null },
    });
}

beforeEach(async () => {
    await home.reset();
    getStorage().setState(initialStorageState, true);
    serverId = await home.addHome({ name: 'Subagent Home', serverUrl: 'https://subagent-home.test',
        serverIdentityId: 'srv_subagent_home', accountId: 'subagent-account', currentAccount: true });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://subagent-home.test', { serverId });
    if (!credentials) throw new Error('Subagent Home Account was not restored');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://subagent-home.test',
        serverIdentityId: 'srv_subagent_home', accountId: 'subagent-account', credentials, request: home.request });
    await sync.awaitBootstrapForegroundAcquisition();
    installSessionActionFixture({ homes: home, storage: getStorage(), serverId,
        session: { id: 's1', active: true, activeAt: Date.now(), presence: 'online',
            access: createSessionAccessFixture('edit'),
            metadata: { flavor: 'claude', path: '/repo', host: 'tester.local', machineId: 'machine_1' } } });
    listedRuns = [];
    seedMessages([]);
    executionRunDetailsSpy.mockClear();
    messageDetailsSpy.mockClear();
    overviewCardSpy.mockClear();
    participantComposerSpy.mockClear();
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await home.reset();
    getStorage().setState(initialStorageState, true);
});

describe('SessionSubagentDetailsView', () => {
    it('distinguishes a roster still loading from an absent subagent', async () => {
        seedMessages([], false);
        const screen = await renderScreen(<SessionSubagentDetailsView sessionId="s1" scopeId="session:s1" subagentId="missing" />);
        expect(screen.findByTestId('session-subagent-details-loading')).toBeTruthy();
        await act(async () => { getStorage().getState().applyMessagesLoaded('s1'); });
        expect(screen.findByTestId('session-subagent-details-unavailable')).toBeTruthy();
    });

    it('delegates execution-run subagents directly to the canonical Run details surface even when a tool transcript exists', async () => {
        const exactServerId = await home.addHome({ name: 'Exact Subagent Home', serverUrl: 'https://subagent-exact.test',
            serverIdentityId: 'srv_subagent_exact', accountId: null, active: false });
        const current = getStorage().getState().sessions.s1!;
        getStorage().setState({ sessions: { s1: { ...current, serverId: exactServerId } } });
        seedMessages([runTool()]);
        await renderScreen(<SessionSubagentDetailsView sessionId="s1" serverId={exactServerId}
            scopeId="session:s1" subagentId="execution_run:run_1" />);

        expect(executionRunDetailsSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', serverId: exactServerId, runId: 'run_1', presentation: 'panel',
        }));
        expect(executionRunDetailsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('showSendComposer');
        expect(participantComposerSpy).not.toHaveBeenCalled();
        expect(overviewCardSpy).not.toHaveBeenCalled();
        expect(messageDetailsSpy).not.toHaveBeenCalled();
    });

    it('falls back to execution-run details when no tool transcript route is available', async () => {
        // A different retained run supplies the real transcript polling signal;
        // the selected run comes only from the genuine Run-list transport.
        seedMessages([runTool('run_other')]);
        listedRuns = [ExecutionRunPublicStateSchema.parse({
            runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1', intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            status: 'running', startedAtMs: Date.now(),
        })];
        await renderScreen(<SessionSubagentDetailsView sessionId="s1" scopeId="session:s1" subagentId="execution_run:run_1" />);
        await vi.waitFor(() => expect(executionRunDetailsSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', runId: 'run_1', presentation: 'panel',
        })));
        expect(messageDetailsSpy).not.toHaveBeenCalled();
    });

    it('renders message details for tool-backed subagents', async () => {
        seedMessages([teamTool('alpha', 'tool-msg-1', 'toolu_1')]);
        await renderScreen(<SessionSubagentDetailsView sessionId="s1" scopeId="session:s1"
            subagentId="agent_team_member:qa-team:alpha@qa-team" />);

        expect(messageDetailsSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', message: expect.objectContaining({ id: 'tool-msg-1', kind: 'tool-call' }),
            showComposer: false,
        }));
        expect(messageDetailsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('presentation');
        expect(overviewCardSpy).toHaveBeenCalledWith(expect.objectContaining({
            subagent: expect.objectContaining({ id: 'agent_team_member:qa-team:alpha@qa-team', kind: 'agent_team_member' }),
        }));
        expect(participantComposerSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', serverId,
            recipient: expect.objectContaining({ kind: 'agent_team_member', teamId: 'qa-team', memberId: 'alpha@qa-team' }),
        }));
        expect(executionRunDetailsSpy).not.toHaveBeenCalled();
    });

    it('allows sending when the session grants agent-input submission', async () => {
        const current = getStorage().getState().sessions.s1!;
        getStorage().setState({ sessions: { s1: { ...current, access: createSessionAccessFixture('owner') } } });
        seedMessages([teamTool('owner', 'tool-msg-owner', 'toolu_owner')]);
        await renderScreen(<SessionSubagentDetailsView sessionId="s1" scopeId="session:s1"
            subagentId="agent_team_member:qa-team:owner@qa-team" />);

        expect(participantComposerSpy).toHaveBeenCalledWith(expect.objectContaining({
            canSendMessages: true,
            recipient: expect.objectContaining({ kind: 'agent_team_member', memberId: 'owner@qa-team' }),
        }));
    });
});
